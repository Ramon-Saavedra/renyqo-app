import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { UploadApiResponse } from 'cloudinary';
import type { EnvironmentVariables } from '../config/env.validation';
import type { Listing } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
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
const ARCHIVE_CONFLICT = 'This listing cannot be archived';

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly listingOrderingService: ListingOrderingService,
    private readonly listingInputRules: ListingInputRules,
    private readonly listingResponseMapper: ListingResponseMapper,
    private readonly activityService: ApplicationActivityService,
  ) {}

  async create(
    providerId: string,
    dto: CreateListingDto,
    file?: Express.Multer.File,
  ): Promise<Listing> {
    if (!this.listingInputRules.hasMeaningfulDraftData(dto) && !file) {
      throw new BadRequestException(
        'Draft must include at least one listing field',
      );
    }

    if (file) {
      return this.createWithImage(providerId, dto, file);
    }

    return runSerializableTransaction(this.prisma, async (tx) =>
      tx.listing.create({
        data: {
          ...this.listingInputRules.buildCreateData(providerId, dto),
          displayOrder: await this.listingOrderingService.getNextDisplayOrder(
            tx,
            providerId,
          ),
        },
      }),
    );
  }

  async findAllByProvider(
    providerId: string,
  ): Promise<ListingWithActiveApplicationsCount[]> {
    return this.prisma.listing.findMany({
      where: { providerId },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      include: {
        _count: {
          select: {
            applications: {
              where: { status: ApplicationStatus.ACTIVE },
            },
          },
        },
      },
    });
  }

  async findOneByProvider(id: string, providerId: string): Promise<Listing> {
    const listing = await this.prisma.listing.findFirst({
      where: { id, providerId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  async findOneDetailByProvider(
    id: string,
    providerId: string,
  ): Promise<ListingWithImages> {
    const listing = await this.prisma.listing.findFirst({
      where: { id, providerId },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  async update(
    id: string,
    providerId: string,
    dto: UpdateListingDto,
  ): Promise<Listing> {
    const listing = await this.findOneByProvider(id, providerId);
    return this.prisma.listing.update({
      where: { id },
      data: this.listingInputRules.buildUpdateData(dto, listing),
    });
  }

  async updatePosition(
    id: string,
    providerId: string,
    dto: UpdateListingPositionDto,
  ): Promise<Listing> {
    return this.listingOrderingService.move(id, providerId, dto.position);
  }

  async publish(id: string, providerId: string): Promise<Listing> {
    const listing = await this.findOneByProvider(id, providerId);

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
      providerId,
      [ListingStatus.DRAFT],
      PUBLISH_CONFLICT,
      {
        status: ListingStatus.PUBLISHED,
        ...(listing.publishedAt === null ? { publishedAt: new Date() } : {}),
      },
    );
  }

  async moveToDraft(id: string, providerId: string): Promise<Listing> {
    return this.transitionListing(
      id,
      providerId,
      [ListingStatus.PUBLISHED, ListingStatus.PAUSED],
      DRAFT_CONFLICT,
      { status: ListingStatus.DRAFT },
    );
  }

  async pause(id: string, providerId: string): Promise<Listing> {
    return this.transitionListing(
      id,
      providerId,
      [ListingStatus.PUBLISHED],
      PAUSE_CONFLICT,
      { status: ListingStatus.PAUSED },
    );
  }

  async resume(id: string, providerId: string): Promise<Listing> {
    return this.transitionListing(
      id,
      providerId,
      [ListingStatus.PAUSED],
      RESUME_CONFLICT,
      { status: ListingStatus.PUBLISHED },
    );
  }

  async archive(id: string, providerId: string): Promise<Listing> {
    return this.transitionListing(
      id,
      providerId,
      [ListingStatus.DRAFT, ListingStatus.PUBLISHED, ListingStatus.PAUSED],
      ARCHIVE_CONFLICT,
      { status: ListingStatus.ARCHIVED },
    );
  }

  async rentListing(
    id: string,
    providerId: string,
    dto: RentListingDto,
  ): Promise<Listing> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${id} FOR UPDATE`;

      const listing = await tx.listing.findFirst({
        where: { id, providerId },
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
            actorUserId: providerId,
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
        actorUserId: providerId,
        actorType: ApplicationActivityActorType.PROVIDER,
        visibility: ApplicationActivityVisibility.BOTH,
        metadata: {
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus: ApplicationStatus.ACCEPTED,
        },
      });

      return tx.listing.update({
        where: { id },
        data: { status: ListingStatus.RENTED, rentedAt: new Date() },
      });
    });
  }

  async countByProvider(providerId: string): Promise<number> {
    return this.prisma.listing.count({ where: { providerId } });
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

  private async createWithImage(
    providerId: string,
    dto: CreateListingDto,
    file: Express.Multer.File,
  ): Promise<Listing> {
    const listingId = randomUUID();
    const uploaded = await this.uploadListingImage(listingId, file);

    try {
      return await runSerializableTransaction(this.prisma, async (tx) => {
        const listing = await tx.listing.create({
          data: {
            id: listingId,
            ...this.listingInputRules.buildCreateData(providerId, dto),
            displayOrder: await this.listingOrderingService.getNextDisplayOrder(
              tx,
              providerId,
            ),
            photos: [uploaded.secure_url],
          },
        });

        await tx.listingImage.create({
          data: {
            listingId,
            publicId: uploaded.public_id,
            secureUrl: uploaded.secure_url,
            position: 0,
            isCover: true,
          },
        });

        return listing;
      });
    } catch (err) {
      await this.deleteUploadedAssetAfterFailure(uploaded.public_id);
      throw err;
    }
  }

  private uploadListingImage(
    listingId: string,
    file: Express.Multer.File,
  ): Promise<UploadApiResponse> {
    const folder = `${this.config.get('CLOUDINARY_FOLDER')}/listings/${listingId}`;
    return this.cloudinaryService.uploadBuffer(file.buffer, folder);
  }

  private async transitionListing(
    id: string,
    providerId: string,
    allowedStatuses: readonly ListingStatus[],
    conflictMessage: string,
    data: ListingStatusWrite,
  ): Promise<Listing> {
    const listing = await this.findOneByProvider(id, providerId);
    return this.commitListingStatus(
      listing,
      providerId,
      allowedStatuses,
      conflictMessage,
      data,
    );
  }

  private async commitListingStatus(
    listing: Listing,
    providerId: string,
    allowedStatuses: readonly ListingStatus[],
    conflictMessage: string,
    data: ListingStatusWrite,
  ): Promise<Listing> {
    if (!allowedStatuses.includes(listing.status)) {
      throw new ConflictException(conflictMessage);
    }

    const updated = await this.prisma.listing.updateMany({
      where: {
        id: listing.id,
        providerId,
        status: listing.status,
        ...(data.publishedAt !== undefined ? { publishedAt: null } : {}),
      },
      data,
    });

    if (updated.count !== 1) {
      const current = await this.prisma.listing.findFirst({
        where: { id: listing.id, providerId },
      });
      if (!current) {
        throw new NotFoundException('Listing not found');
      }
      throw new ConflictException(conflictMessage);
    }

    return this.findOneByProvider(listing.id, providerId);
  }

  private async deleteUploadedAssetAfterFailure(
    publicId: string,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteByPublicId(publicId);
    } catch (err) {
      this.logger.error(
        'Failed to delete Cloudinary asset after database failure',
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
