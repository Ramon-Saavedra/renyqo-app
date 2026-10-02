import { Injectable } from '@nestjs/common';
import { ApplicationViewingStatus } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationViewingPolicy } from './application-viewing.policy';

@Injectable()
export class ApplicationViewingReadService {
  constructor(readonly policy: ApplicationViewingPolicy) {}

  async batch(tx: Prisma.TransactionClient, applicationIds: readonly string[]) {
    const latest = await tx.applicationViewing.groupBy({
      by: ['applicationId'],
      where: { applicationId: { in: [...applicationIds] } },
      _max: { round: true },
    });
    const rounds = new Map(
      latest.map((row) => [row.applicationId, row._max.round]),
    );
    const rows = await tx.applicationViewing.findMany({
      where: {
        applicationId: { in: [...applicationIds] },
        OR: [
          ...latest.map((row) => ({
            applicationId: row.applicationId,
            round: row._max.round ?? 0,
          })),
          { status: ApplicationViewingStatus.COMPLETED, interest: null },
        ],
      },
      select: {
        id: true,
        applicationId: true,
        round: true,
        status: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        changeRequestedAt: true,
        interest: { select: { id: true } },
        outcomes: {
          select: { recordedAt: true },
          orderBy: { revision: 'desc' },
          take: 1,
        },
      },
    });
    return { rows, rounds };
  }

  facts(
    rows: Awaited<ReturnType<ApplicationViewingReadService['batch']>>['rows'],
    mutable: boolean,
    latestRound: number | null | undefined,
    asOf: Date,
  ) {
    return rows.map((row) => {
      const nextAction = this.policy.nextAction(
        row,
        mutable,
        row.round === latestRound,
        asOf,
      );
      const pendingSince =
        nextAction === 'PROVIDER_CLOSE_UNANSWERED_VIEWING'
          ? row.startsAt
          : nextAction === 'PROVIDER_RECORD_VIEWING_OUTCOME'
            ? row.endsAt
            : nextAction === 'PROVIDER_RESPOND_TO_CHANGE_REQUEST'
              ? (row.changeRequestedAt ?? row.createdAt)
              : nextAction === 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST'
                ? (row.outcomes[0]?.recordedAt ?? row.createdAt)
                : row.createdAt;
      return { viewingId: row.id, nextAction, pendingSince };
    });
  }
}
