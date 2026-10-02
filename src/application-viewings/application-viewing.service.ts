import { createHash } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType as Actor,
  ApplicationActivityType as Event,
  ApplicationActivityVisibility,
  ApplicationViewingStatus as Status,
} from '../generated/prisma/enums';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import {
  ApplicationViewingAccessService,
  type ViewingAudience,
} from './application-viewing-access.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
  viewingInclude,
} from './application-viewing.policy';
import type {
  ProposeViewingDto,
  RequestViewingChangeDto,
} from './dto/viewing-input.dto';
import type { ViewingResponseDto } from './dto/viewing-response.dto';

type ResponseAction = 'accept' | 'decline' | 'request-change' | 'cancel';

@Injectable()
export class ApplicationViewingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationViewingAccessService,
    private readonly query: ApplicationViewingQueryService,
    private readonly policy: ApplicationViewingPolicy,
    private readonly clock: ViewingClock,
    private readonly activity: ApplicationActivityService,
  ) {}

  propose(
    applicationId: string,
    userId: string,
    dto: ProposeViewingDto,
    previousId?: string,
  ): Promise<ViewingResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.mutation(
        tx,
        applicationId,
        userId,
        'provider',
      );
      const now = this.clock.now();
      const canonical = {
        command: previousId ? 'reschedule' : 'propose',
        previousId: previousId ?? null,
        startsAt: this.policy.instant(dto.startsAt, dto.timeZone).toISOString(),
        endsAt: this.policy.instant(dto.endsAt, dto.timeZone).toISOString(),
        timeZone: dto.timeZone,
        providerNote: this.policy.text(dto.providerNote),
      };
      const hash = createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex');
      const replay = await tx.applicationViewing.findUnique({
        where: {
          applicationId_requestKey: {
            applicationId,
            requestKey: dto.requestKey,
          },
        },
      });
      if (replay) {
        if (replay.requestHash !== hash)
          throw new ConflictException(
            'Request key was already used with different input',
          );
        return this.query.response(tx, application, 'provider', replay.id);
      }
      const schedule = this.policy.schedule(dto, now);
      const latest = await tx.applicationViewing.findFirst({
        where: { applicationId },
        orderBy: { round: 'desc' },
        include: viewingInclude,
      });
      if (previousId) {
        const previous = await this.query.find(tx, applicationId, previousId);
        if (
          previous.id !== latest?.id ||
          !this.policy.unresolved(previous) ||
          now >= previous.startsAt
        )
          throw new ConflictException(
            'Only the current future viewing can be rescheduled',
          );
        await tx.applicationViewing.update({
          where: { id: previousId },
          data: { status: Status.SUPERSEDED, supersededAt: now },
        });
      } else if (latest && this.policy.unresolved(latest))
        throw new ConflictException('An unresolved viewing already exists');
      const viewing = await tx.applicationViewing.create({
        data: {
          applicationId,
          round: (latest?.round ?? 0) + 1,
          ...schedule,
          requestKey: dto.requestKey,
          requestHash: hash,
          createdAt: now,
        },
      });
      await this.append(
        tx,
        applicationId,
        userId,
        'provider',
        previousId ? Event.VIEWING_RESCHEDULED : Event.VIEWING_PROPOSED,
        viewing.id,
        viewing.round,
        now,
        previousId ??
          (latest?.status === Status.CHANGE_REQUESTED ? latest.id : undefined),
        viewing.startsAt,
        viewing.endsAt,
      );
      return this.query.response(tx, application, 'provider', viewing.id);
    });
  }

  respond(
    applicationId: string,
    viewingId: string,
    userId: string,
    action: ResponseAction,
    dto: RequestViewingChangeDto = {},
  ): Promise<ViewingResponseDto> {
    const side: ViewingAudience =
      action === 'cancel' ? 'provider' : 'applicant';
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.mutation(
        tx,
        applicationId,
        userId,
        side,
      );
      const row = await this.query.find(tx, applicationId, viewingId);
      const now = this.clock.now();
      const target = {
        accept: Status.ACCEPTED,
        decline: Status.DECLINED,
        'request-change': Status.CHANGE_REQUESTED,
        cancel: Status.CANCELLED,
      }[action];
      const message =
        action === 'request-change' ? this.policy.text(dto.message) : null;
      if (row.status === target) {
        if (action === 'request-change' && row.changeRequestMessage !== message)
          throw new ConflictException('Change response is final');
        return this.query.response(tx, application, side, row.id);
      }
      const latest = await tx.applicationViewing.findFirst({
        where: { applicationId },
        orderBy: { round: 'desc' },
        select: { id: true },
      });
      const flags = this.policy.capabilities(
        row,
        side,
        true,
        latest?.id === row.id,
        now,
      );
      const allowed = {
        accept: flags.canAccept,
        decline: flags.canDecline,
        'request-change': flags.canRequestAnotherTime,
        cancel: flags.canCancel,
      }[action];
      if (!allowed)
        throw new ConflictException('Viewing does not allow this action');
      const data: Prisma.ApplicationViewingUpdateInput = { status: target };
      if (action === 'accept') data.acceptedAt = now;
      if (action === 'decline') data.declinedAt = now;
      if (action === 'cancel') data.cancelledAt = now;
      if (action === 'request-change') {
        data.changeRequestedAt = now;
        data.changeRequestMessage = message;
      }
      await tx.applicationViewing.update({ where: { id: viewingId }, data });
      const event = {
        accept: Event.VIEWING_ACCEPTED,
        decline: Event.VIEWING_DECLINED,
        'request-change': Event.VIEWING_CHANGE_REQUESTED,
        cancel: Event.VIEWING_CANCELLED,
      }[action];
      await this.append(
        tx,
        applicationId,
        userId,
        side,
        event,
        row.id,
        row.round,
        now,
      );
      return this.query.response(tx, application, side, row.id);
    });
  }

  append(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ViewingAudience,
    type: Event,
    viewingId: string,
    round: number,
    occurredAt: Date,
    previousViewingId?: string,
    startsAt?: Date,
    endsAt?: Date,
  ) {
    return this.activity.appendWithinTransaction(tx, {
      applicationId,
      actorUserId: userId,
      actorType: side === 'provider' ? Actor.PROVIDER : Actor.APPLICANT,
      visibility: ApplicationActivityVisibility.BOTH,
      type,
      occurredAt,
      metadata: {
        viewingId,
        viewingRound: round,
        previousViewingId,
        startsAt: startsAt?.toISOString(),
        endsAt: endsAt?.toISOString(),
      },
    });
  }
}
