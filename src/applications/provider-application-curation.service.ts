import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Application } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventSource,
  ListingEventType,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { ApplicationTransactionClient } from './application-lifecycle.service';
import { ACTIVE_APPLICATIONS_LIMIT } from './application-lifecycle.constants';
import { ApplicationTransactionService } from './application-transaction.service';
import { ApplicationWaitingPromotionService } from './application-waiting-promotion.service';
import { ApplicationActivityService } from './application-activity.service';
import { providerCurationAllowed } from './application-process.policy';

@Injectable()
export class ProviderApplicationCurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    private readonly transactionService: ApplicationTransactionService,
    private readonly promotionService: ApplicationWaitingPromotionService,
    private readonly activityService: ApplicationActivityService,
  ) {}

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

      if (application.status === ApplicationStatus.WAITING) {
        throw new NotFoundException('Application not found');
      }

      if (application.status !== ApplicationStatus.ACTIVE) {
        throw new ConflictException('This application cannot be rejected');
      }

      await this.transactionService.lockListing(tx, application.listingId);
      await this.transactionService.lockApplication(tx, applicationId);
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

      await this.activityService.appendWithinTransaction(tx, {
        applicationId,
        type: ApplicationActivityType.APPLICATION_REJECTED,
        actorUserId: providerId,
        actorType: ApplicationActivityActorType.PROVIDER,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: now,
        metadata: {
          fromStatus: ApplicationStatus.ACTIVE,
          toStatus: ApplicationStatus.REJECTED,
          reason: ApplicationRejectionReason.NOT_SELECTED,
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
          await this.promotionService.promoteWithinTransaction(tx, listing);
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
        select: { listingId: true, listing: { select: { providerId: true } } },
      });

      if (
        !applicationReference ||
        applicationReference.listing.providerId !== providerId
      ) {
        throw new NotFoundException('Application not found');
      }

      await this.transactionService.lockListing(
        tx,
        applicationReference.listingId,
      );
      await this.transactionService.lockApplication(tx, applicationId);

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

      const profile = await this.transactionService.lockApplicantProfile(
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
        await this.transactionService.assignWaitingQueueOrder(
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

      await this.activityService.appendWithinTransaction(tx, {
        applicationId,
        type: ApplicationActivityType.APPLICATION_RESTORED,
        actorUserId: providerId,
        actorType: ApplicationActivityActorType.PROVIDER,
        visibility: restoreToActive
          ? ApplicationActivityVisibility.BOTH
          : ApplicationActivityVisibility.APPLICANT,
        occurredAt: now,
        metadata: {
          fromStatus: ApplicationStatus.REJECTED,
          toStatus: restoreToActive
            ? ApplicationStatus.ACTIVE
            : ApplicationStatus.WAITING,
        },
      });

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

  private async assertProviderCurationCooldown(
    tx: ApplicationTransactionClient,
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

    if (!providerCurationAllowed(lastEvent?.occurredAt ?? null, now)) {
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
}
