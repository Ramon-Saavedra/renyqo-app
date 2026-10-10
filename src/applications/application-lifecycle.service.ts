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
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ApplicationAdmissionService } from './application-admission.service';
import { applicationCanWithdraw } from './application-process.policy';

import { ACTIVE_APPLICATIONS_LIMIT } from './application-lifecycle.constants';
import { ApplicationActivityService } from './application-activity.service';
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
    private readonly activityService: ApplicationActivityService,
    private readonly admissionService: ApplicationAdmissionService,
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

      const histories = await this.admissionService.historyForListings(
        tx,
        applicantId,
        [listingId],
      );
      const history = histories.get(listingId) ?? [];
      const admission = this.admissionService.evaluate(
        history,
        listing.status,
        true,
        new Date(),
      );
      if (!admission.canSubmitApplication) {
        throw new ConflictException({
          message:
            admission.submissionBlockReason ===
            'APPLICATION_REAPPLICATION_COOLDOWN'
              ? 'Re-application is temporarily unavailable after provider rejection'
              : 'You have already applied to this listing',
          code: admission.submissionBlockReason,
          reapplyAvailableAt: admission.reapplyAvailableAt,
        });
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
      const now = new Date(
        history.reduce(
          (timestamp, row) => Math.max(timestamp, row.createdAt.getTime() + 1),
          Date.now(),
        ),
      );

      try {
        const application = await tx.application.create({
          data: {
            listingId,
            applicantId,
            status,
            createdAt: now,
            activeAt: isActive ? now : undefined,
          },
        });

        await this.activityService.appendWithinTransaction(tx, {
          applicationId: application.id,
          type: ApplicationActivityType.APPLICATION_SUBMITTED,
          actorUserId: applicantId,
          actorType: ApplicationActivityActorType.APPLICANT,
          visibility: isActive
            ? ApplicationActivityVisibility.BOTH
            : ApplicationActivityVisibility.APPLICANT,
          occurredAt: now,
          metadata: { initialStatus: status },
        });

        return application;
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

      if (!applicationCanWithdraw(application.status)) {
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

      await this.activityService.appendWithinTransaction(tx, {
        applicationId,
        type: ApplicationActivityType.APPLICATION_WITHDRAWN,
        actorUserId: applicantId,
        actorType: ApplicationActivityActorType.APPLICANT,
        visibility:
          application.status === ApplicationStatus.ACTIVE
            ? ApplicationActivityVisibility.BOTH
            : ApplicationActivityVisibility.APPLICANT,
        metadata: {
          fromStatus: application.status,
          toStatus: ApplicationStatus.WITHDRAWN,
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

        await this.activityService.appendWithinTransaction(tx, {
          applicationId: application.id,
          type: ApplicationActivityType.APPLICATION_REJECTED,
          actorType: ApplicationActivityActorType.SYSTEM,
          visibility: ApplicationActivityVisibility.APPLICANT,
          metadata: {
            fromStatus: application.status,
            toStatus: ApplicationStatus.REJECTED,
            reason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
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
