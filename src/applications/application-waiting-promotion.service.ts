import { Injectable } from '@nestjs/common';
import type { Prisma, Listing } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { ApplicationTransactionService } from './application-transaction.service';
import { ApplicationActivityService } from './application-activity.service';
import {
  ACTIVE_APPLICATIONS_LIMIT,
  MAX_PROMOTION_CANDIDATES,
  PROMOTION_BATCH_SIZE,
} from './application-lifecycle.constants';

@Injectable()
export class ApplicationWaitingPromotionService {
  constructor(
    private readonly eligibilityService: EligibilityService,
    private readonly transactionService: ApplicationTransactionService,
    private readonly activityService: ApplicationActivityService,
  ) {}

  async promoteWithinTransaction(
    tx: Prisma.TransactionClient,
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
        const profile = await this.transactionService.lockApplicantProfile(
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
        await this.activityService.appendWithinTransaction(tx, {
          applicationId: application.id,
          type: ApplicationActivityType.APPLICATION_PROMOTED_TO_ACTIVE,
          actorType: ApplicationActivityActorType.SYSTEM,
          visibility: ApplicationActivityVisibility.BOTH,
          metadata: {
            fromStatus: ApplicationStatus.WAITING,
            toStatus: ApplicationStatus.ACTIVE,
          },
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
}
