import { Injectable } from '@nestjs/common';
import { ApplicationViewingStatus } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationViewingPolicy } from './application-viewing.policy';
import type { ViewingAudience } from './application-viewing-access.service';

@Injectable()
export class ApplicationViewingReadService {
  constructor(readonly policy: ApplicationViewingPolicy) {}

  summary(
    rows: Awaited<ReturnType<ApplicationViewingReadService['batch']>>['rows'],
    mutable: boolean,
    latestRound: number | null | undefined,
    asOf: Date,
    audience: ViewingAudience,
  ) {
    const ordered = [...rows].sort((a, b) => b.round - a.round);
    const latest = ordered.find((row) => row.round === latestRound);
    const current = ordered.find((row) => this.policy.unresolved(row));
    const completed = ordered.find(
      (row) => row.status === ApplicationViewingStatus.COMPLETED,
    );
    const pending = ordered.find(
      (row) =>
        row.status === ApplicationViewingStatus.COMPLETED && !row.interest,
    );
    const dto = (row: typeof latest) =>
      row
        ? {
            viewingId: row.id,
            status: row.status,
            startsAt: row.startsAt,
            endsAt: row.endsAt,
            timeZone: row.timeZone,
            effectiveOutcome: row.outcomes.at(-1)?.outcome ?? null,
            postViewingInterest: row.interest
              ? {
                  interest: row.interest.interest,
                  respondedAt: row.interest.respondedAt,
                }
              : null,
            nextAction: this.policy.nextAction(
              row,
              mutable,
              row.round === latestRound,
              asOf,
            ),
            capabilities: this.policy.capabilities(
              row,
              audience,
              mutable,
              row.round === latestRound,
              asOf,
            ),
          }
        : null;
    const currentDto = dto(current);
    const latestDto = dto(latest);
    const pendingDto = dto(pending);
    return {
      current: currentDto,
      latest: latestDto,
      latestCompleted: dto(completed),
      pendingInterest: pendingDto,
      changeRequested:
        latest?.status === ApplicationViewingStatus.CHANGE_REQUESTED
          ? latestDto
          : null,
      canPropose: audience === 'provider' && mutable && !current,
      nextAction:
        currentDto && currentDto.nextAction !== 'NONE'
          ? currentDto.nextAction
          : latest?.status === ApplicationViewingStatus.CHANGE_REQUESTED
            ? (latestDto?.nextAction ?? 'NONE')
            : (pendingDto?.nextAction ?? 'NONE'),
    };
  }

  async batch(tx: Prisma.TransactionClient, applicationIds: readonly string[]) {
    if (!applicationIds.length)
      return { rows: [], rounds: new Map<string, number | null>() };
    const latest = await tx.applicationViewing.groupBy({
      by: ['applicationId'],
      where: { applicationId: { in: [...applicationIds] } },
      _max: { round: true },
    });
    const rounds = new Map(
      latest.map((row) => [row.applicationId, row._max.round]),
    );
    const completed = await tx.applicationViewing.groupBy({
      by: ['applicationId'],
      where: {
        applicationId: { in: [...applicationIds] },
        status: ApplicationViewingStatus.COMPLETED,
      },
      _max: { round: true },
    });
    const rows = await tx.applicationViewing.findMany({
      where: {
        applicationId: { in: [...applicationIds] },
        OR: [
          ...latest.map((row) => ({
            applicationId: row.applicationId,
            round: row._max.round ?? 0,
          })),
          ...completed.map((row) => ({
            applicationId: row.applicationId,
            round: row._max.round ?? 0,
          })),
          {
            status: {
              in: [
                ApplicationViewingStatus.PROPOSED,
                ApplicationViewingStatus.ACCEPTED,
              ],
            },
          },
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
        timeZone: true,
        createdAt: true,
        changeRequestedAt: true,
        interest: { select: { id: true, interest: true, respondedAt: true } },
        outcomes: {
          select: { recordedAt: true, revision: true, outcome: true },
          orderBy: { revision: 'asc' },
          take: 2,
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
                ? (row.outcomes.at(-1)?.recordedAt ?? row.createdAt)
                : row.createdAt;
      return { viewingId: row.id, nextAction, pendingSince };
    });
  }
}
