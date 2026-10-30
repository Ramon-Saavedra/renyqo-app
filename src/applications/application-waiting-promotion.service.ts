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
    return (await this.reconcileWithinTransaction(tx, listing)).promotedCount;
  }

  /** Caller holds the listing lock in its Serializable transaction.
   * A remaining slot is authoritative only after the entire eligible queue is served.
   */
  async reconcileWithinTransaction(
    tx: Prisma.TransactionClient,
    listing: Listing,
  ): Promise<{ promotedCount: number; remainingCapacity: number }> {
    if (listing.status !== ListingStatus.PUBLISHED) {
      return { promotedCount: 0, remainingCapacity: 0 };
    }

    let activeCount = await tx.application.count({
      where: { listingId: listing.id, status: ApplicationStatus.ACTIVE },
    });

    if (activeCount >= ACTIVE_APPLICATIONS_LIMIT) {
      return { promotedCount: 0, remainingCapacity: 0 };
    }

    let promotedCount = 0;
    let queueCursor: { queueOrder: bigint; id: string } | undefined;

    while (activeCount < ACTIVE_APPLICATIONS_LIMIT) {
      const waitingApplications = await tx.application.findMany({
        where: {
          listingId: listing.id,
          status: ApplicationStatus.WAITING,
          ...(queueCursor === undefined
            ? {}
            : {
                OR: [
                  { queueOrder: { gt: queueCursor.queueOrder } },
                  {
                    queueOrder: queueCursor.queueOrder,
                    id: { gt: queueCursor.id },
                  },
                ],
              }),
        },
        orderBy: [{ queueOrder: 'asc' }, { id: 'asc' }],
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

        queueCursor = {
          queueOrder: application.queueOrder,
          id: application.id,
        };
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

    return {
      promotedCount,
      remainingCapacity: ACTIVE_APPLICATIONS_LIMIT - activeCount,
    };
  }
}
