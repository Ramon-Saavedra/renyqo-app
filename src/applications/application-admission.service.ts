import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventSource,
  ListingEventType,
  ListingStatus,
} from '../generated/prisma/enums';

export const REAPPLICATION_COOLDOWN_MS = 720 * 60 * 60 * 1000;

export type ApplicationAdmissionHistory = {
  id: string;
  listingId: string;
  status: ApplicationStatus;
  publicReason: ApplicationRejectionReason | null;
  rejectedAt: Date | null;
  createdAt: Date;
  listingEvents: { occurredAt: Date }[];
};

export type ApplicationSubmissionBlockReason =
  | 'AUTHENTICATION_REQUIRED'
  | 'LISTING_NOT_ACCEPTING_APPLICATIONS'
  | 'CURRENT_APPLICATION_EXISTS'
  | 'APPLICATION_ACCEPTED'
  | 'APPLICATION_REAPPLICATION_COOLDOWN'
  | 'APPLICATION_HISTORY_REQUIRES_REVIEW'
  | 'LISTING_RENTED'
  | 'APPLICANT_NOT_ELIGIBLE';

export type ApplicationAdmission = {
  hasApplicationHistory: boolean;
  currentApplicationId: string | null;
  currentApplicationStatus: ApplicationStatus | null;
  canSubmitApplication: boolean;
  submissionBlockReason: ApplicationSubmissionBlockReason | null;
  reapplyAvailableAt: Date | null;
};

@Injectable()
export class ApplicationAdmissionService {
  async historyForListings(
    tx: Prisma.TransactionClient,
    applicantId: string,
    listingIds: readonly string[],
  ): Promise<ReadonlyMap<string, ApplicationAdmissionHistory[]>> {
    if (!listingIds.length) return new Map();
    const rows = await tx.application.findMany({
      where: { applicantId, listingId: { in: [...listingIds] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        listingId: true,
        status: true,
        publicReason: true,
        rejectedAt: true,
        createdAt: true,
        listingEvents: {
          where: {
            type: ListingEventType.REJECTED_BY_PROVIDER,
            source: ListingEventSource.PROVIDER,
            reason: ApplicationRejectionReason.NOT_SELECTED,
          },
          select: { occurredAt: true },
          orderBy: { occurredAt: 'desc' },
          take: 1,
        },
      },
    });
    const groups = new Map<string, ApplicationAdmissionHistory[]>();
    for (const row of rows) {
      const group = groups.get(row.listingId) ?? [];
      group.push(row);
      groups.set(row.listingId, group);
    }
    return groups;
  }

  evaluate(
    history: readonly ApplicationAdmissionHistory[],
    listingStatus: ListingStatus,
    eligible: boolean,
    asOf: Date,
  ): ApplicationAdmission {
    const current = history.find(
      (row) =>
        row.status === ApplicationStatus.ACTIVE ||
        row.status === ApplicationStatus.WAITING,
    );
    let latestRejection: Date | null = null;
    let unknownRejection = false;
    for (const row of history) {
      const event = row.listingEvents[0];
      const rejection =
        event?.occurredAt ??
        (row.publicReason === ApplicationRejectionReason.NOT_SELECTED
          ? row.rejectedAt
          : null);
      if (rejection && (!latestRejection || rejection > latestRejection)) {
        latestRejection = rejection;
      }
      if (
        row.status === ApplicationStatus.REJECTED &&
        (row.publicReason === null ||
          (row.publicReason === ApplicationRejectionReason.NOT_SELECTED &&
            !rejection))
      ) {
        unknownRejection = true;
      }
    }
    const expiry = latestRejection
      ? new Date(latestRejection.getTime() + REAPPLICATION_COOLDOWN_MS)
      : null;
    const cooldown = expiry !== null && asOf.getTime() < expiry.getTime();
    let reason: ApplicationSubmissionBlockReason | null = null;
    if (listingStatus !== ListingStatus.PUBLISHED) {
      reason = 'LISTING_NOT_ACCEPTING_APPLICATIONS';
    } else if (current) {
      reason = 'CURRENT_APPLICATION_EXISTS';
    } else if (
      history.some((row) => row.status === ApplicationStatus.ACCEPTED)
    ) {
      reason = 'APPLICATION_ACCEPTED';
    } else if (
      history.some(
        (row) =>
          row.status === ApplicationStatus.REJECTED &&
          row.publicReason === ApplicationRejectionReason.LISTING_RENTED,
      )
    ) {
      reason = 'LISTING_RENTED';
    } else if (unknownRejection) {
      reason = 'APPLICATION_HISTORY_REQUIRES_REVIEW';
    } else if (cooldown) {
      reason = 'APPLICATION_REAPPLICATION_COOLDOWN';
    } else if (!eligible) {
      reason = 'APPLICANT_NOT_ELIGIBLE';
    }
    return {
      hasApplicationHistory: history.length > 0,
      currentApplicationId: current?.id ?? null,
      currentApplicationStatus: current?.status ?? null,
      canSubmitApplication: reason === null,
      submissionBlockReason: reason,
      reapplyAvailableAt: cooldown ? expiry : null,
    };
  }

  async hasNewerAttempt(
    tx: Prisma.TransactionClient,
    application: {
      id: string;
      applicantId: string;
      listingId: string;
      createdAt: Date;
    },
  ): Promise<boolean> {
    return (
      (await tx.application.findFirst({
        where: {
          applicantId: application.applicantId,
          listingId: application.listingId,
          id: { not: application.id },
          createdAt: { gt: application.createdAt },
        },
        select: { id: true },
      })) !== null
    );
  }
}
