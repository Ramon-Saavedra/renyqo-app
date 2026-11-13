import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Listing } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { ViewingLifecycleService } from '../applications/viewing-lifecycle.service';
import {
  ProviderListingAccess,
  providerListingWhere,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import { ListingOrderingService } from './listing-ordering.service';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import type { ListingWithImages } from './dto/listing-response.dto';
import {
  ProviderListingOverviewResponseDto,
  type ListingWithActiveApplicationsCount,
} from './dto/provider-listing-overview-response.dto';
import type { UpdateListingDto } from './dto/update-listing.dto';
import type { RentListingDto } from './dto/rent-listing.dto';
import type { UpdateListingPositionDto } from './dto/update-listing-position.dto';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';
import { ListingCriteriaRevisionService } from '../eligibility/listing-criteria-revision.service';
import { ApplicationEligibilityAssessmentService } from '../eligibility/application-eligibility-assessment.service';

const PUBLISH_REQUIRED_FIELDS = [
  'title',
  'street',
  'zip',
  'city',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'availableFrom',
] as const;

type PublishRequiredField = (typeof PUBLISH_REQUIRED_FIELDS)[number];

type ListingStatusWrite = {
  status: ListingStatus;
  publishedAt?: Date;
};

const PUBLISH_CONFLICT = 'This listing cannot be published';
const DRAFT_CONFLICT = 'This listing cannot be moved to draft';
const PAUSE_CONFLICT = 'This listing cannot be paused';
const RESUME_CONFLICT = 'This listing cannot be resumed';
const RETIRE_CONFLICT = 'This listing cannot be retired';

@Injectable()
export class ListingsService {
  constructor(
    private readonly access: ProviderListingAccess,
    private readonly listingOrderingService: ListingOrderingService,
    private readonly listingInputRules: ListingInputRules,
    private readonly listingResponseMapper: ListingResponseMapper,
    private readonly activityService: ApplicationActivityService,
    private readonly viewingLifecycle: ViewingLifecycleService,
    private readonly applicationLifecycle: ApplicationLifecycleService,
    private readonly criteriaRevisions: ListingCriteriaRevisionService,
    private readonly assessments: ApplicationEligibilityAssessmentService,
  ) {}

  create(
    _actor: ProviderActor,
    _dto: CreateListingDto,
    _file?: Express.Multer.File,
  ): Promise<Listing> {
    void _dto;
    void _file;
    return this.access.read(_actor, 'listing.create', undefined, () =>
      Promise.reject(
        new ServiceUnavailableException(
          'Listing creation requires entitlement/quota integration',
        ),
      ),
    );
  }

  async findAllByProvider(
    actor: ProviderActor,
  ): Promise<ListingWithActiveApplicationsCount[]> {
    return this.access.read(
      actor,
      'listing.read',
      undefined,
      async (tx, context) =>
        tx.listing.findMany({
          where: {
            ...providerListingWhere(context),
            status: { not: 'RETIRED' },
          },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          include: {
            _count: {
              select: {
                applications: { where: { status: ApplicationStatus.ACTIVE } },
              },
            },
          },
        }),
    );
  }

  findOneByProvider(id: string, actor: ProviderActor): Promise<Listing> {
    return this.access.read(actor, 'listing.read', id, (tx) =>
      tx.listing.findUniqueOrThrow({
        where: { id, workspaceId: actor.workspaceId },
      }),
    );
  }

  findOneDetailByProvider(
    id: string,
    actor: ProviderActor,
  ): Promise<ListingWithImages> {
    return this.access.read(actor, 'listing.read', id, (tx) =>
      tx.listing.findUniqueOrThrow({
        where: { id, workspaceId: actor.workspaceId },
        include: { images: { orderBy: { position: 'asc' } } },
      }),
    );
  }

  async update(
    id: string,
    actor: ProviderActor,
    dto: UpdateListingDto,
  ): Promise<Listing> {
    return this.access.mutate(actor, 'listing.write', id, async (tx) => {
      const listing = await tx.listing.findFirst({
        where: { id, workspaceId: actor.workspaceId },
      });
      if (!listing) throw new NotFoundException('Listing not found');

      const updated = await tx.listing.update({
        where: { id },
        data: this.listingInputRules.buildUpdateData(dto, listing),
      });
      const revision = await this.criteriaRevisions.changed(
        tx,
        listing,
        updated,
        actor.authority.userId,
      );
      if (revision) {
        await this.assessments.reassessListing(
          tx,
          updated,
          revision,
          actor.authority.userId,
        );
        await this.activityService.lifecycleChangedForListingWithinTransaction(
          tx,
          id,
          revision.recordedAt,
        );
      }
      return updated;
    });
  }

  async updatePosition(
    id: string,
    actor: ProviderActor,
    dto: UpdateListingPositionDto,
  ): Promise<Listing> {
    return this.listingOrderingService.move(id, actor, dto.position);
  }

  async publish(id: string, actor: ProviderActor): Promise<Listing> {
    const listing = await this.findOneByProvider(id, actor);

    if (listing.status !== ListingStatus.DRAFT) {
      throw new ConflictException(PUBLISH_CONFLICT);
    }

    const missingFields = PUBLISH_REQUIRED_FIELDS.filter(
      (field: PublishRequiredField) => listing[field] == null,
    );

    if (missingFields.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Listing is missing required fields for publishing',
        missingFields,
      });
    }

    return this.commitListingStatus(
      listing,
      actor,
      [ListingStatus.DRAFT],
      PUBLISH_CONFLICT,
      {
        status: ListingStatus.PUBLISHED,
        ...(listing.publishedAt === null ? { publishedAt: new Date() } : {}),
      },
    );
  }

  async moveToDraft(id: string, actor: ProviderActor): Promise<Listing> {
    return this.transitionListing(
      id,
      actor,
      [ListingStatus.PUBLISHED, ListingStatus.PAUSED],
      DRAFT_CONFLICT,
      { status: ListingStatus.DRAFT },
    );
  }

  async pause(id: string, actor: ProviderActor): Promise<Listing> {
    return this.transitionListing(
      id,
      actor,
      [ListingStatus.PUBLISHED],
      PAUSE_CONFLICT,
      { status: ListingStatus.PAUSED },
    );
  }

  async resume(id: string, actor: ProviderActor): Promise<Listing> {
    return this.transitionListing(
      id,
      actor,
      [ListingStatus.PAUSED],
      RESUME_CONFLICT,
      { status: ListingStatus.PUBLISHED },
    );
  }

  async retire(id: string, actor: ProviderActor): Promise<Listing> {
    return this.transitionListing(
      id,
      actor,
      [
        ListingStatus.DRAFT,
        ListingStatus.PUBLISHED,
        ListingStatus.PAUSED,
        ListingStatus.RENTED,
      ],
      RETIRE_CONFLICT,
      { status: ListingStatus.RETIRED },
    );
  }

  async rentListing(
    id: string,
    actor: ProviderActor,
    dto: RentListingDto,
  ): Promise<Listing> {
    return this.access.mutate(actor, 'listing.write', id, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${id} FOR UPDATE`;

      const listing = await tx.listing.findFirst({
        where: { id, workspaceId: actor.workspaceId },
      });

      if (!listing) {
        throw new NotFoundException('Listing not found');
      }

      if (
        listing.status !== ListingStatus.PUBLISHED &&
        listing.status !== ListingStatus.PAUSED
      ) {
        throw new ConflictException('This listing cannot be marked as rented');
      }

      const selectedApplication = await tx.application.findUnique({
        where: { id: dto.selectedApplicationId },
      });

      if (
        !selectedApplication ||
        selectedApplication.listingId !== id ||
        selectedApplication.status !== ApplicationStatus.ACTIVE
      ) {
        throw new ConflictException(
          'The selected application is not valid for this listing',
        );
      }

      await this.viewingLifecycle.closeListingWithinTransaction(
        tx,
        id,
        'LISTING_RENTED',
        actor.authority.userId,
        dto.selectedApplicationId,
      );
      const nonSelectedApplications = await tx.application.findMany({
        where: {
          listingId: id,
          id: { not: dto.selectedApplicationId },
          status: {
            in: [ApplicationStatus.ACTIVE, ApplicationStatus.WAITING],
          },
        },
        select: { id: true, status: true },
      });

      if (nonSelectedApplications.length > 0) {
        await tx.application.updateMany({
          where: {
            id: {
              in: nonSelectedApplications.map((application) => application.id),
            },
          },
          data: {
            status: ApplicationStatus.REJECTED,
            rejectedAt: new Date(),
            publicReason: ApplicationRejectionReason.LISTING_RENTED,
          },
        });

        await this.activityService.appendManyWithinTransaction(
          tx,
          nonSelectedApplications.map((application) => ({
            applicationId: application.id,
            type: ApplicationActivityType.APPLICATION_REJECTED,
            actorUserId: actor.authority.userId,
            actorType: ApplicationActivityActorType.PROVIDER,
            visibility:
              application.status === ApplicationStatus.ACTIVE
                ? ApplicationActivityVisibility.BOTH
                : ApplicationActivityVisibility.APPLICANT,
            metadata: {
              fromStatus: application.status,
              toStatus: ApplicationStatus.REJECTED,
              reason: ApplicationRejectionReason.LISTING_RENTED,
            },
          })),
        );
      }

      await tx.application.update({
        where: { id: dto.selectedApplicationId },
        data: { status: ApplicationStatus.ACCEPTED },
      });

      await this.activityService.appendWithinTransaction(tx, {
        applicationId: dto.selectedApplicationId,
        type: ApplicationActivityType.APPLICATION_ACCEPTED,
        actorUserId: actor.authority.userId,
        actorType: ApplicationActivityActorType.PROVIDER,
        visibility: ApplicationActivityVisibility.BOTH,
        metadata: {
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus: ApplicationStatus.ACCEPTED,
        },
      });

      const result = await tx.listing.update({
        where: { id },
        data: { status: ListingStatus.RENTED, rentedAt: new Date() },
      });
      await this.activityService.lifecycleChangedForListingWithinTransaction(
        tx,
        id,
        new Date(),
      );
      return result;
    });
  }

  async countByProvider(actor: ProviderActor): Promise<number> {
    return this.access.read(actor, 'listing.count', undefined, (tx, context) =>
      tx.listing.count({
        where: { ...providerListingWhere(context), status: { not: 'RETIRED' } },
      }),
    );
  }

  toListingResponse(
    listing: ListingWithImages,
    options: { exposeExactAddress?: boolean } = {},
  ): ListingResponseDto {
    return this.listingResponseMapper.toListingResponse(listing, options);
  }

  toListingResponses(
    listings: readonly ListingWithImages[],
    options: { exposeExactAddress?: boolean } = {},
  ): ListingResponseDto[] {
    return this.listingResponseMapper.toListingResponses(listings, options);
  }

  toProviderListingOverviewResponses(
    listings: readonly ListingWithActiveApplicationsCount[],
    options: { exposeExactAddress?: boolean } = {},
  ): ProviderListingOverviewResponseDto[] {
    return this.listingResponseMapper.toProviderListingOverviewResponses(
      listings,
      options,
    );
  }

  private async transitionListing(
    id: string,
    actor: ProviderActor,
    allowedStatuses: readonly ListingStatus[],
    conflictMessage: string,
    data: ListingStatusWrite,
  ): Promise<Listing> {
    const listing = await this.findOneByProvider(id, actor);
    return this.commitListingStatus(
      listing,
      actor,
      allowedStatuses,
      conflictMessage,
      data,
    );
  }

  private async commitListingStatus(
    listing: Listing,
    actor: ProviderActor,
    allowedStatuses: readonly ListingStatus[],
    conflictMessage: string,
    data: ListingStatusWrite,
  ): Promise<Listing> {
    if (!allowedStatuses.includes(listing.status)) {
      throw new ConflictException(conflictMessage);
    }

    return this.access.mutate(
      actor,
      'listing.write',
      listing.id,
      async (tx) => {
        const updated = await tx.listing.updateMany({
          where: {
            id: listing.id,
            workspaceId: actor.workspaceId,
            revision: listing.revision,
            status: listing.status,
            ...(data.publishedAt !== undefined ? { publishedAt: null } : {}),
          },
          data,
        });

        if (updated.count !== 1) {
          const current = await tx.listing.findFirst({
            where: { id: listing.id, workspaceId: actor.workspaceId },
          });
          if (!current) {
            throw new NotFoundException('Listing not found');
          }
          throw new ConflictException(conflictMessage);
        }

        if (
          data.status === ListingStatus.RETIRED ||
          data.status === ListingStatus.DRAFT
        )
          await this.viewingLifecycle.closeListingWithinTransaction(
            tx,
            listing.id,
            data.status === ListingStatus.RETIRED
              ? 'LISTING_RETIRED'
              : 'LISTING_UNPUBLISHED',
            actor.authority.userId,
          );
        if (data.status === ListingStatus.RETIRED)
          await this.listingOrderingService.compactWithinTransaction(
            tx,
            actor.workspaceId,
          );
        const result = await tx.listing.findFirst({
          where: { id: listing.id, workspaceId: actor.workspaceId },
          include: { images: { orderBy: { position: 'asc' } } },
        });
        if (!result) throw new NotFoundException('Listing not found');
        if (data.status === ListingStatus.PUBLISHED) {
          await this.applicationLifecycle.reconcileWaitingWithinTransaction(
            tx,
            result,
          );
        }
        await this.activityService.lifecycleChangedForListingWithinTransaction(
          tx,
          listing.id,
          new Date(),
        );
        return result;
      },
    );
  }
}
