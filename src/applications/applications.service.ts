import {
  ConflictException,
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

      const rejected = await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.REJECTED,
          rejectedAt: new Date(),
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
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
  ): Promise<ProviderExitedApplicationRecord[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.prisma.application.findMany({
      where: {
        listingId,
        listing: { providerId },
        activeAt: { not: null },
        status: {
          in: [ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED],
        },
      },
      orderBy: [
        { status: 'asc' },
        { withdrawnAt: { sort: 'desc', nulls: 'last' } },
        { rejectedAt: { sort: 'desc', nulls: 'last' } },
      ],
      select: {
        id: true,
        listingId: true,
        status: true,
        publicReason: true,
        rejectedAt: true,
        withdrawnAt: true,
        applicant: {
          select: { name: true },
        },
      },
    });
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
