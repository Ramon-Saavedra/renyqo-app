import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationViewingStatus as Status } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplicationViewingAccessService,
  type ViewingApplication,
  type ViewingAudience,
} from './application-viewing-access.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
  viewingInclude,
  type ViewingRecord,
} from './application-viewing.policy';
import { ViewingQueryDto } from './dto/viewing-input.dto';
import {
  ViewingInterestResponseDto,
  ViewingOutcomeResponseDto,
  ViewingPageResponseDto,
  ViewingResponseDto,
} from './dto/viewing-response.dto';

@Injectable()
export class ApplicationViewingQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationViewingAccessService,
    private readonly policy: ApplicationViewingPolicy,
    private readonly clock: ViewingClock,
  ) {}

  async find(
    tx: Prisma.TransactionClient,
    applicationId: string,
    viewingId: string,
  ): Promise<ViewingRecord> {
    const viewing = await tx.applicationViewing.findFirst({
      where: { id: viewingId, applicationId },
      include: viewingInclude,
    });
    if (!viewing) throw new NotFoundException('Viewing not found');
    return viewing;
  }

  async response(
    tx: Prisma.TransactionClient,
    application: ViewingApplication,
    side: ViewingAudience,
    viewingId: string,
  ): Promise<ViewingResponseDto> {
    const viewing = await this.find(tx, application.id, viewingId);
    const latest = await tx.applicationViewing.findFirst({
      where: { applicationId: application.id },
      orderBy: { round: 'desc' },
      select: { round: true },
    });
    return this.toDto(
      viewing,
      application,
      side,
      latest?.round === viewing.round,
      this.clock.now(),
    );
  }

  detail(
    applicationId: string,
    viewingId: string,
    userId: string,
    side: ViewingAudience,
  ): Promise<ViewingResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          side,
        );
        return this.response(tx, application, side, viewingId);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  list(
    applicationId: string,
    userId: string,
    side: ViewingAudience,
    query: ViewingQueryDto,
  ): Promise<ViewingPageResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          side,
        );
        const where = { applicationId };
        const [latest, current, completed, pending, rows] = await Promise.all([
          tx.applicationViewing.findFirst({
            where,
            orderBy: { round: 'desc' },
            include: viewingInclude,
          }),
          tx.applicationViewing.findFirst({
            where: {
              ...where,
              status: { in: [Status.PROPOSED, Status.ACCEPTED] },
            },
            include: viewingInclude,
          }),
          tx.applicationViewing.findFirst({
            where: { ...where, status: Status.COMPLETED },
            orderBy: { round: 'desc' },
            include: viewingInclude,
          }),
          tx.applicationViewing.findFirst({
            where: { ...where, status: Status.COMPLETED, interest: null },
            orderBy: { round: 'desc' },
            include: viewingInclude,
          }),
          tx.applicationViewing.findMany({
            where: {
              ...where,
              ...(query.beforeRound > 0
                ? { round: { lt: query.beforeRound } }
                : {}),
            },
            orderBy: { round: 'desc' },
            take: query.limit + 1,
            include: viewingInclude,
          }),
        ]);
        const now = this.clock.now();
        const dto = (row: ViewingRecord | null) =>
          row
            ? this.toDto(
                row,
                application,
                side,
                row.round === latest?.round,
                now,
              )
            : null;
        const latestDto = dto(latest);
        const currentDto = dto(current);
        const pendingDto = dto(pending);
        const hasMore = rows.length > query.limit;
        const history = rows
          .slice(0, query.limit)
          .map((row) =>
            this.toDto(
              row,
              application,
              side,
              row.round === latest?.round,
              now,
            ),
          );
        const primary =
          currentDto?.nextAction !== undefined &&
          currentDto.nextAction !== 'NONE'
            ? currentDto.nextAction
            : latestDto?.status === Status.CHANGE_REQUESTED
              ? latestDto.nextAction
              : (pendingDto?.nextAction ?? 'NONE');
        return new ViewingPageResponseDto(
          applicationId,
          latestDto,
          currentDto,
          dto(completed),
          pendingDto,
          latest?.status === Status.CHANGE_REQUESTED ? latestDto : null,
          history,
          hasMore,
          hasMore ? (history.at(-1)?.round ?? null) : null,
          side === 'provider' &&
            this.access.canMutate(application) &&
            current === null,
          primary,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  toDto(
    row: ViewingRecord,
    application: ViewingApplication,
    side: ViewingAudience,
    latest: boolean,
    now: Date,
  ): ViewingResponseDto {
    const mutable = this.access.canMutate(application);
    const response = new ViewingResponseDto(
      row.id,
      row.applicationId,
      row.round,
      row.status,
      row.startsAt,
      row.endsAt,
      row.timeZone,
      row.providerNote,
      row.acceptedAt,
      row.declinedAt,
      row.changeRequestedAt,
      row.changeRequestMessage,
      row.cancelledAt,
      row.supersededAt,
      row.createdAt,
      row.updatedAt,
      row.outcomes.map(
        (outcome) =>
          new ViewingOutcomeResponseDto(
            outcome.revision,
            outcome.outcome,
            outcome.correctionReason,
            outcome.recordedAt,
          ),
      ),
      row.interest
        ? new ViewingInterestResponseDto(
            row.interest.interest,
            row.interest.respondedAt,
          )
        : null,
      this.policy.nextAction(row, mutable, latest, now),
      this.policy.unresolved(row) && now >= row.endsAt,
      mutable ? null : 'APPLICATION_PROCESS_INACTIVE',
    );
    Object.assign(
      response,
      this.policy.capabilities(row, side, mutable, latest, now),
    );
    return response;
  }
}
