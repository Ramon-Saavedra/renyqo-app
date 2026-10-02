import { ConflictException, Injectable } from '@nestjs/common';
import { ApplicationActivityService } from '../applications/application-activity.service';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType as Actor,
  ApplicationActivityType as Event,
  ApplicationActivityVisibility,
  ApplicationViewingStatus as Status,
  ViewingOutcome,
  ViewingInterest,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ApplicationViewingAccessService } from './application-viewing-access.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
} from './application-viewing.policy';
import type { CorrectViewingOutcomeDto } from './dto/viewing-input.dto';
import type { ViewingResponseDto } from './dto/viewing-response.dto';

@Injectable()
export class ApplicationViewingOutcomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationViewingAccessService,
    private readonly query: ApplicationViewingQueryService,
    private readonly policy: ApplicationViewingPolicy,
    private readonly clock: ViewingClock,
    private readonly activity: ApplicationActivityService,
  ) {}

  record(
    applicationId: string,
    viewingId: string,
    userId: string,
    outcome: ViewingOutcome,
    correction?: CorrectViewingOutcomeDto,
  ): Promise<ViewingResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.mutation(
        tx,
        applicationId,
        userId,
        'provider',
      );
      const row = await this.query.find(tx, applicationId, viewingId);
      const now = this.clock.now();
      const latest = await tx.applicationViewing.findFirst({
        where: { applicationId },
        orderBy: { round: 'desc' },
        select: { id: true },
      });
      const status =
        outcome === ViewingOutcome.COMPLETED
          ? Status.COMPLETED
          : Status.NO_SHOW;
      const previous = row.outcomes.at(-1);
      const reason = correction ? this.policy.text(correction.reason) : null;
      if (
        correction &&
        previous?.revision === 2 &&
        previous.outcome === outcome &&
        previous.correctionReason === reason
      )
        return this.query.response(tx, application, 'provider', viewingId);
      if (!correction && row.outcomes[0]?.outcome === outcome)
        return this.query.response(tx, application, 'provider', viewingId);
      const flags = this.policy.capabilities(
        row,
        'provider',
        true,
        latest?.id === row.id,
        now,
      );
      if (
        correction
          ? !flags.canCorrectOutcome || previous?.outcome === outcome
          : !flags.canMarkCompleted
      )
        throw new ConflictException(
          'Viewing does not allow this outcome operation',
        );
      const revision = correction ? 2 : 1;
      await tx.applicationViewingOutcome.create({
        data: {
          viewingId,
          revision,
          outcome,
          correctionReason: reason,
          recordedAt: now,
        },
      });
      await tx.applicationViewing.update({
        where: { id: viewingId },
        data: { status },
      });
      await this.append(
        tx,
        applicationId,
        viewingId,
        row.round,
        userId,
        correction
          ? Event.VIEWING_OUTCOME_CORRECTED
          : outcome === ViewingOutcome.COMPLETED
            ? Event.VIEWING_COMPLETED
            : Event.VIEWING_NO_SHOW,
        now,
        revision,
      );
      return this.query.response(tx, application, 'provider', viewingId);
    });
  }

  interest(
    applicationId: string,
    viewingId: string,
    userId: string,
    interest: ViewingInterest,
  ): Promise<ViewingResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const application = await this.access.mutation(
        tx,
        applicationId,
        userId,
        'applicant',
      );
      const row = await this.query.find(tx, applicationId, viewingId);
      if (row.status !== Status.COMPLETED)
        throw new ConflictException('Interest requires a completed viewing');
      if (row.interest) {
        if (row.interest.interest !== interest)
          throw new ConflictException(
            'Post-viewing interest response is final',
          );
        return this.query.response(tx, application, 'applicant', viewingId);
      }
      const now = this.clock.now();
      await tx.applicationViewingInterest.create({
        data: { viewingId, interest, respondedAt: now },
      });
      await this.append(
        tx,
        applicationId,
        viewingId,
        row.round,
        userId,
        interest === ViewingInterest.STILL_INTERESTED
          ? Event.VIEWING_INTEREST_CONFIRMED
          : Event.VIEWING_INTEREST_DECLINED,
        now,
      );
      return this.query.response(tx, application, 'applicant', viewingId);
    });
  }

  private append(
    tx: Prisma.TransactionClient,
    applicationId: string,
    viewingId: string,
    round: number,
    userId: string,
    type: Event,
    occurredAt: Date,
    outcomeRevision?: number,
  ) {
    return this.activity.appendWithinTransaction(tx, {
      applicationId,
      actorUserId: userId,
      actorType:
        type === Event.VIEWING_INTEREST_CONFIRMED ||
        type === Event.VIEWING_INTEREST_DECLINED
          ? Actor.APPLICANT
          : Actor.PROVIDER,
      visibility: ApplicationActivityVisibility.BOTH,
      type,
      occurredAt,
      metadata: { viewingId, viewingRound: round, outcomeRevision },
    });
  }
}
