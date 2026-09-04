import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import {
  Prisma,
  type ApplicantProfile,
  type Application,
  type Listing,
} from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventSource,
  ListingEventType,
  ListingStatus,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';
import type { EligibilityWarning } from '../eligibility/dto/eligibility-response.dto';
import type { ProviderActiveApplicationRecord } from './dto/provider-active-application-response.dto';
import type { ProviderExitedApplicationRecord } from './dto/provider-exited-application-response.dto';

const ACTIVE_APPLICATIONS_LIMIT = 5;
const PROMOTION_BATCH_SIZE = 50;
const MAX_PROMOTION_CANDIDATES = 500;
const PROVIDER_CURATION_COOLDOWN_MS = 60_000;

type TransactionClient = Prisma.TransactionClient;

function computeProviderActiveApplicantWarnings(
  profile: Pick<ApplicantProfile, 'hasPets' | 'isSmoker'> | null,
  listing: {
    petsPolicy: PetsPolicy | null;
    smokingPolicy: SmokingPolicy | null;
  },
): EligibilityWarning[] {
  const warnings: EligibilityWarning[] = [];

  if (profile === null) {
    return warnings;
  }

  if (
    profile.hasPets === true &&
    listing.petsPolicy === PetsPolicy.BY_ARRANGEMENT
  ) {
    warnings.push('pets_by_arrangement');
  }

  if (
    profile.isSmoker === true &&
    listing.smokingPolicy === SmokingPolicy.BY_ARRANGEMENT
  ) {
    warnings.push('smoking_by_arrangement');
  }

  return warnings;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
  ) {}

  async apply(listingId: string, applicantId: string): Promise<Application> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockListing(tx, listingId);
      const listing = await tx.listing.findUnique({
        where: { id: listingId },
      });

      if (!listing) {
        throw new NotFoundException('Listing not found');
      }

      if (listing.status !== ListingStatus.PUBLISHED) {
        throw new UnprocessableEntityException(
          'This listing is not accepting applications',
        );
      }

      const existingBlockingApplication = await tx.application.findFirst({
        where: {
          listingId,
          applicantId,
          status: {
            in: [
              ApplicationStatus.ACTIVE,
              ApplicationStatus.WAITING,
              ApplicationStatus.REJECTED,
              ApplicationStatus.ACCEPTED,
            ],
          },
        },
      });

      if (existingBlockingApplication) {
        throw new ConflictException('You have already applied to this listing');
      }

      const profile = await this.lockApplicantProfile(tx, applicantId);
      const eligibility = this.eligibilityService.evaluate(listing, profile);

      if (!eligibility.canApply) {
        throw new UnprocessableEntityException({
          message: 'Applicant is not eligible for this listing',
          ...eligibility,
        });
      }

      const activeCount = await tx.application.count({
        where: { listingId, status: ApplicationStatus.ACTIVE },
      });
      const isActive = activeCount < ACTIVE_APPLICATIONS_LIMIT;
      const status = isActive
        ? ApplicationStatus.ACTIVE
        : ApplicationStatus.WAITING;

      try {
        const now = new Date();
        return await tx.application.create({
          data: {
            listingId,
            applicantId,
            status,
            createdAt: now,
            activeAt: isActive ? now : undefined,
          },
        });
      } catch (err) {
        if (
          err instanceof PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictException(
            'You have already applied to this listing',
          );
        }
        throw err;
      }
    });
  }

  async withdraw(
    applicationId: string,
    applicantId: string,
  ): Promise<Application> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const applicationReference = await tx.application.findUnique({
        where: { id: applicationId },
        select: { listingId: true },
      });

      if (!applicationReference) {
        throw new NotFoundException('Application not found');
      }

      await this.lockListing(tx, applicationReference.listingId);
      await this.lockApplication(tx, applicationId);

      const application = await tx.application.findUnique({
        where: { id: applicationId },
      });

      if (!application || application.applicantId !== applicantId) {
        throw new NotFoundException('Application not found');
      }

      if (application.status === ApplicationStatus.WITHDRAWN) {
        return application;
      }

      if (
        application.status !== ApplicationStatus.ACTIVE &&
        application.status !== ApplicationStatus.WAITING
      ) {
        throw new ConflictException('This application cannot be withdrawn');
      }

      const withdrawn = await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.WITHDRAWN,
          ...(application.status === ApplicationStatus.ACTIVE
            ? { withdrawnAt: new Date() }
            : {}),
        },
      });

      if (application.status === ApplicationStatus.ACTIVE) {
        const listing = await tx.listing.findUnique({
          where: { id: application.listingId },
        });

        if (listing) {
          await this.promoteWithinTransaction(tx, listing);
        }
      }

      return withdrawn;
    });
  }

  async reject(
    applicationId: string,
    providerId: string,
  ): Promise<Application> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await tx.application.findUnique({
        where: { id: applicationId },
        include: {
          listing: { select: { id: true, providerId: true, status: true } },
        },
      });

      if (!application) {
        throw new NotFoundException('Application not found');
      }

      if (application.listing.providerId !== providerId) {
        throw new NotFoundException('Application not found');
      }

      if (application.status !== ApplicationStatus.ACTIVE) {
        throw new ConflictException('This application cannot be rejected');
      }

      await this.lockListing(tx, application.listingId);
      await this.lockApplication(tx, applicationId);

      const now = new Date();
      await this.assertProviderCurationCooldown(tx, applicationId, now);

      const rejected = await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.REJECTED,
          rejectedAt: now,
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
        },
      });

      await tx.listingEvent.create({
        data: {
          listingId: application.listingId,
          applicationId,
          type: ListingEventType.REJECTED_BY_PROVIDER,
          source: ListingEventSource.PROVIDER,
          actorUserId: providerId,
          reason: ApplicationRejectionReason.NOT_SELECTED,
          payload: {
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.REJECTED,
          },
          occurredAt: now,
        },
      });

      if (application.listing.status === ListingStatus.PUBLISHED) {
        const listing = await tx.listing.findUnique({
          where: { id: application.listingId },
        });

        if (listing) {
          await this.promoteWithinTransaction(tx, listing);
        }
      }

      return rejected;
    });
  }

  async restore(
    applicationId: string,
    providerId: string,
  ): Promise<Application> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const applicationReference = await tx.application.findUnique({
        where: { id: applicationId },
        select: {
          listingId: true,
          listing: { select: { providerId: true } },
        },
      });

      if (
        !applicationReference ||
        applicationReference.listing.providerId !== providerId
      ) {
        throw new NotFoundException('Application not found');
      }

      await this.lockListing(tx, applicationReference.listingId);
      await this.lockApplication(tx, applicationId);

      const application = await tx.application.findUnique({
        where: { id: applicationId },
        include: { listing: true },
      });

      if (!application) {
        throw new NotFoundException('Application not found');
      }

      if (application.listing.status !== ListingStatus.PUBLISHED) {
        throw new ConflictException(
          'This listing is not accepting applications',
        );
      }

      if (
        application.status !== ApplicationStatus.REJECTED ||
        application.publicReason !== ApplicationRejectionReason.NOT_SELECTED
      ) {
        throw new ConflictException('This application cannot be restored');
      }

      const profile = await this.lockApplicantProfile(
        tx,
        application.applicantId,
      );
      const eligibility = this.eligibilityService.evaluate(
        application.listing,
        profile,
      );

      if (!eligibility.canApply) {
        throw new UnprocessableEntityException({
          message: 'Applicant is not eligible for this listing',
          ...eligibility,
        });
      }

      const now = new Date();
      await this.assertProviderCurationCooldown(tx, applicationId, now);

      const activeCount = await tx.application.count({
        where: {
          listingId: application.listingId,
          status: ApplicationStatus.ACTIVE,
        },
      });
      const restoreToActive = activeCount < ACTIVE_APPLICATIONS_LIMIT;

      let restored: Application;
      if (restoreToActive) {
        restored = await tx.application.update({
          where: { id: applicationId },
          data: {
            status: ApplicationStatus.ACTIVE,
            activeAt: now,
            rejectedAt: null,
            publicReason: null,
          },
        });
      } else {
        await this.assignWaitingQueueOrder(
          tx,
          application.listingId,
          applicationId,
        );
        restored = await tx.application.update({
          where: { id: applicationId },
          data: {
            status: ApplicationStatus.WAITING,
            activeAt: null,
            rejectedAt: null,
            publicReason: null,
          },
        });
      }

      await tx.listingEvent.create({
        data: {
          listingId: application.listingId,
          applicationId,
          type: ListingEventType.RESTORED_BY_PROVIDER,
          source: ListingEventSource.PROVIDER,
          actorUserId: providerId,
          reason: ApplicationRejectionReason.NOT_SELECTED,
          payload: {
            fromStatus: ApplicationStatus.REJECTED,
            toStatus: restoreToActive
              ? ApplicationStatus.ACTIVE
              : ApplicationStatus.WAITING,
          },
          occurredAt: now,
        },
      });

      return restored;
    });
  }

  async promoteWaitingApplications(listingId: string): Promise<number> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockListing(tx, listingId);
      const listing = await tx.listing.findUnique({
        where: { id: listingId },
      });

      if (!listing) {
        return 0;
      }

      return this.promoteWithinTransaction(tx, listing);
    });
  }

  private async promoteWithinTransaction(
    tx: TransactionClient,
    listing: Listing,
  ): Promise<number> {
    if (listing.status !== ListingStatus.PUBLISHED) {
      return 0;
    }

    let activeCount = await tx.application.count({
      where: { listingId: listing.id, status: ApplicationStatus.ACTIVE },
    });
    if (activeCount >= ACTIVE_APPLICATIONS_LIMIT) {
      return 0;
    }

    let promotedCount = 0;
    let queueCursor: bigint | undefined;
    let processedCandidates = 0;

    while (
      activeCount < ACTIVE_APPLICATIONS_LIMIT &&
      processedCandidates < MAX_PROMOTION_CANDIDATES
    ) {
      const waitingApplications = await tx.application.findMany({
        where: {
          listingId: listing.id,
          status: ApplicationStatus.WAITING,
          ...(queueCursor === undefined
            ? {}
            : { queueOrder: { gt: queueCursor } }),
        },
        orderBy: { queueOrder: 'asc' },
        take: PROMOTION_BATCH_SIZE,
        select: { id: true, applicantId: true, queueOrder: true },
      });

      if (waitingApplications.length === 0) {
        break;
      }

      for (const application of waitingApplications) {
        if (activeCount >= ACTIVE_APPLICATIONS_LIMIT) {
          break;
        }

        processedCandidates++;
        queueCursor = application.queueOrder;
        const profile = await this.lockApplicantProfile(
          tx,
          application.applicantId,
        );
        if (!this.eligibilityService.evaluate(listing, profile).canApply) {
          continue;
        }

        await tx.application.update({
          where: { id: application.id },
          data: { status: ApplicationStatus.ACTIVE, activeAt: new Date() },
        });
        activeCount++;
        promotedCount++;
      }

      if (waitingApplications.length < PROMOTION_BATCH_SIZE) {
        break;
      }
    }

    return promotedCount;
  }

  async revalidateActiveAndWaitingApplications(
    tx: TransactionClient,
    applicantId: string,
    profile: ApplicantProfile,
  ): Promise<void> {
    const applications = await tx.application.findMany({
      where: {
        applicantId,
        status: {
          in: [ApplicationStatus.ACTIVE, ApplicationStatus.WAITING],
        },
      },
      include: { listing: true },
    });

    type ApplicationWithListing = Prisma.ApplicationGetPayload<{
      include: { listing: true };
    }>;
    const applicationsByListing = new Map<string, ApplicationWithListing[]>();
    for (const application of applications) {
      const listingApplications = applicationsByListing.get(
        application.listingId,
      );
      if (listingApplications === undefined) {
        applicationsByListing.set(application.listingId, [application]);
      } else {
        listingApplications.push(application);
      }
    }

    const sortedListingIds = Array.from(applicationsByListing.keys()).sort();

    for (const listingId of sortedListingIds) {
      await this.lockListing(tx, listingId);

      const listingApplications = applicationsByListing.get(listingId);
      if (listingApplications === undefined) {
        continue;
      }

      for (const application of listingApplications) {
        const eligibility = this.eligibilityService.evaluate(
          application.listing,
          profile,
        );

        if (eligibility.canApply) {
          continue;
        }

        const wasActive = application.status === ApplicationStatus.ACTIVE;

        await tx.application.update({
          where: { id: application.id },
          data: {
            status: ApplicationStatus.REJECTED,
            rejectedAt: new Date(),
            publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
          },
        });

        if (
          wasActive &&
          application.listing.status === ListingStatus.PUBLISHED
        ) {
          await this.promoteWithinTransaction(tx, application.listing);
        }
      }
    }
  }

  async findAllByApplicantWithListing(
    applicantId: string,
  ): Promise<ApplicantApplicationRecord[]> {
    const applications = await this.prisma.application.findMany({
      where: { applicantId },
      orderBy: { createdAt: 'desc' },
      include: {
        listing: {
          select: {
            id: true,
            title: true,
            city: true,
            coldRent: true,
            images: {
              select: { secureUrl: true, isCover: true, position: true },
              orderBy: { position: 'asc' },
            },
          },
        },
      },
    });

    return applications;
  }

  async findAllByProvider(providerId: string): Promise<Application[]> {
    return this.prisma.application.findMany({
      where: {
        listing: { providerId },
        status: { not: ApplicationStatus.WAITING },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByListing(
    listingId: string,
    providerId: string,
  ): Promise<Application[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.prisma.application.findMany({
      where: {
        listingId,
        listing: { providerId },
        status: { not: ApplicationStatus.WAITING },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findWaitingCountByListing(
    listingId: string,
    providerId: string,
  ): Promise<number> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.prisma.application.count({
      where: { listingId, status: ApplicationStatus.WAITING },
    });
  }

  async findActiveByListing(
    listingId: string,
    providerId: string,
  ): Promise<ProviderActiveApplicationRecord[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true, petsPolicy: true, smokingPolicy: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const applications = await this.prisma.application.findMany({
      where: {
        listingId,
        status: ApplicationStatus.ACTIVE,
        listing: { providerId },
      },
      orderBy: { createdAt: 'asc' },
      take: ACTIVE_APPLICATIONS_LIMIT,
      select: {
        id: true,
        listingId: true,
        status: true,
        activeAt: true,
        applicant: {
          select: {
            name: true,
            profile: {
              select: {
                peopleCount: true,
                hasPets: true,
                isSmoker: true,
              },
            },
          },
        },
      },
    });

    return applications.map((application) => ({
      id: application.id,
      listingId: application.listingId,
      status: application.status,
      activeAt: application.activeAt,
      applicant: {
        name: application.applicant.name,
        profile: application.applicant.profile
          ? { peopleCount: application.applicant.profile.peopleCount }
          : null,
      },
      warnings: computeProviderActiveApplicantWarnings(
        application.applicant.profile,
        listing,
      ),
    }));
  }

  async findExitedByListing(
    listingId: string,
    providerId: string,
  ): Promise<{ items: ProviderExitedApplicationRecord[]; totalCount: number }> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    type ExitedApplicationRow = {
      id: string;
      listingId: string;
      status: string;
      publicReason: string | null;
      rejectedAt: Date | null;
      withdrawnAt: Date | null;
      applicantName: string;
    };

    const EXITED_APPLICATIONS_LIMIT = 5;

    const [rows, totalCount] = await Promise.all([
      this.prisma.$queryRaw<ExitedApplicationRow[]>`
        SELECT
          a.id,
          a.listing_id AS "listingId",
          a.status,
          a.public_reason AS "publicReason",
          a.rejected_at AS "rejectedAt",
          a.withdrawn_at AS "withdrawnAt",
          u.name AS "applicantName"
        FROM "applications" AS a
        JOIN "users" AS u ON u.id = a.applicant_id
        JOIN "listings" AS l ON l.id = a.listing_id
        WHERE a.listing_id = ${listingId}::uuid
          AND l.provider_id = ${providerId}::uuid
          AND a.active_at IS NOT NULL
          AND a.status IN ('withdrawn', 'rejected')
        ORDER BY COALESCE(a.rejected_at, a.withdrawn_at) DESC NULLS LAST, a.id DESC
        LIMIT ${EXITED_APPLICATIONS_LIMIT}
      `,
      this.prisma.application.count({
        where: {
          listingId,
          listing: { providerId },
          activeAt: { not: null },
          status: {
            in: [ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED],
          },
        },
      }),
    ]);

    const mapStatus = (value: string): ApplicationStatus => {
      switch (value) {
        case 'withdrawn':
          return ApplicationStatus.WITHDRAWN;
        case 'rejected':
          return ApplicationStatus.REJECTED;
        default:
          throw new Error(`Unexpected exited application status: ${value}`);
      }
    };

    const mapReason = (
      value: string | null,
    ): ApplicationRejectionReason | null => {
      if (value === null) {
        return null;
      }

      switch (value) {
        case 'not_selected':
          return ApplicationRejectionReason.NOT_SELECTED;
        case 'listing_rented':
          return ApplicationRejectionReason.LISTING_RENTED;
        case 'profile_no_longer_eligible':
          return ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE;
        default:
          throw new Error(
            `Unexpected exited application rejection reason: ${value}`,
          );
      }
    };

    const items = rows.map((row) => {
      const exitedAt = row.rejectedAt ?? row.withdrawnAt;

      if (!exitedAt) {
        throw new Error(
          `Exited application ${row.id} has neither rejectedAt nor withdrawnAt`,
        );
      }

      return {
        id: row.id,
        listingId: row.listingId,
        status: mapStatus(row.status),
        publicReason: mapReason(row.publicReason),
        exitedAt,
        applicant: { name: row.applicantName },
      };
    });

    return { items, totalCount: Number(totalCount) };
  }

  private async lockListing(
    tx: TransactionClient,
    listingId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${listingId} FOR UPDATE`;
  }

  private async lockApplication(
    tx: TransactionClient,
    applicationId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "applications" WHERE id = ${applicationId} FOR UPDATE`;
  }

  private async assertProviderCurationCooldown(
    tx: TransactionClient,
    applicationId: string,
    now: Date,
  ): Promise<void> {
    const lastEvent = await tx.listingEvent.findFirst({
      where: {
        applicationId,
        type: {
          in: [
            ListingEventType.REJECTED_BY_PROVIDER,
            ListingEventType.RESTORED_BY_PROVIDER,
          ],
        },
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });

    if (
      lastEvent &&
      now.getTime() - lastEvent.occurredAt.getTime() <
        PROVIDER_CURATION_COOLDOWN_MS
    ) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'PROVIDER_CURATION_RATE_LIMITED',
          message:
            'Too many provider curation actions. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async assignWaitingQueueOrder(
    tx: TransactionClient,
    listingId: string,
    applicationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      UPDATE "applications"
      SET "queue_order" = COALESCE(
        (SELECT MAX("queue_order") FROM "applications"
         WHERE "listing_id" = ${listingId}::uuid AND "status" = 'waiting'),
        0
      ) + 1
      WHERE "id" = ${applicationId}::uuid
    `;
  }

  private async lockApplicantProfile(
    tx: TransactionClient,
    applicantId: string,
  ) {
    await tx.$queryRaw`SELECT id FROM "applicant_profiles" WHERE applicant_id = ${applicantId} FOR UPDATE`;
    return tx.applicantProfile.findUnique({
      where: { applicantId },
    });
  }
}
