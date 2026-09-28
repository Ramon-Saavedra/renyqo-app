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
} from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { BLOCKING_APPLICATION_STATUSES } from './blocking-application-statuses';

import { ACTIVE_APPLICATIONS_LIMIT } from './application-lifecycle.constants';
import { ApplicationTransactionService } from './application-transaction.service';
import { ApplicationWaitingPromotionService } from './application-waiting-promotion.service';

export type ApplicationTransactionClient = Prisma.TransactionClient;

@Injectable()
export class ApplicationLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    private readonly transactionService: ApplicationTransactionService,
    private readonly promotionService: ApplicationWaitingPromotionService,
  ) {}

  async apply(listingId: string, applicantId: string): Promise<Application> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.transactionService.lockListing(tx, listingId);
      const listing = await tx.listing.findUnique({ where: { id: listingId } });

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
          status: { in: [...BLOCKING_APPLICATION_STATUSES] },
        },
      });

      if (existingBlockingApplication) {
        throw new ConflictException('You have already applied to this listing');
      }

      const profile = await this.transactionService.lockApplicantProfile(
        tx,
        applicantId,
      );
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
      const now = new Date();

      try {
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

      await this.transactionService.lockListing(
        tx,
        applicationReference.listingId,
      );
      await this.transactionService.lockApplication(tx, applicationId);

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
          await this.promotionService.promoteWithinTransaction(tx, listing);
        }
      }

      return withdrawn;
    });
  }

  async promoteWaitingApplications(listingId: string): Promise<number> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.transactionService.lockListing(tx, listingId);
      const listing = await tx.listing.findUnique({ where: { id: listingId } });

      if (!listing) {
        return 0;
      }

      return this.promotionService.promoteWithinTransaction(tx, listing);
    });
  }

  async revalidateActiveAndWaitingApplications(
    tx: ApplicationTransactionClient,
    applicantId: string,
    profile: ApplicantProfile,
  ): Promise<void> {
    const applications = await tx.application.findMany({
      where: {
        applicantId,
        status: { in: [ApplicationStatus.ACTIVE, ApplicationStatus.WAITING] },
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

    for (const listingId of Array.from(applicationsByListing.keys()).sort()) {
      await this.transactionService.lockListing(tx, listingId);
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
          await this.promotionService.promoteWithinTransaction(
            tx,
            application.listing,
          );
        }
      }
    }
  }
}
