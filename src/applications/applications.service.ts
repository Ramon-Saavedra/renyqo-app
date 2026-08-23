import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import {
  Prisma,
  type Application,
  type Listing,
} from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';

const ACTIVE_APPLICATIONS_LIMIT = 5;
const SERIALIZABLE_TRANSACTION_RETRIES = 8;
const PROMOTION_BATCH_SIZE = 50;
const MAX_PROMOTION_CANDIDATES = 500;

type TransactionClient = Prisma.TransactionClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasSerializationCode(value: unknown): boolean {
  return isRecord(value) && value.originalCode === '40001';
}

function isSerializationConflict(error: unknown): boolean {
  if (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  if (error.code === 'P2034' || hasSerializationCode(error.cause)) {
    return true;
  }

  const meta = isRecord(error.meta) ? error.meta : undefined;
  const driverAdapterError = meta?.driverAdapterError;
  return (
    isRecord(driverAdapterError) &&
    hasSerializationCode(driverAdapterError.cause)
  );
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
  ) {}

  async apply(listingId: string, applicantId: string): Promise<Application> {
    return this.runSerializableTransaction(async (tx) => {
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
      const status =
        activeCount < ACTIVE_APPLICATIONS_LIMIT
          ? ApplicationStatus.ACTIVE
          : ApplicationStatus.WAITING;

      try {
        return await tx.application.create({
          data: { listingId, applicantId, status },
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
    return this.runSerializableTransaction(async (tx) => {
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
        data: { status: ApplicationStatus.WITHDRAWN },
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
    return this.runSerializableTransaction(async (tx) => {
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
    return this.runSerializableTransaction(async (tx) => {
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
          data: { status: ApplicationStatus.ACTIVE },
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
        status: ApplicationStatus.ACTIVE,
        listing: { providerId },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async runSerializableTransaction<T>(
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < SERIALIZABLE_TRANSACTION_RETRIES;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (err) {
        if (
          !isSerializationConflict(err) ||
          attempt === SERIALIZABLE_TRANSACTION_RETRIES - 1
        ) {
          throw err;
        }
        const delayMs = Math.min(250, 10 * 2 ** attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error('Application transaction could not be completed');
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
