import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationConsiderationService } from '../applications/application-consideration.service';
import {
  ApplicationActivityActorType as Actor,
  ApplicationActivityType as Event,
} from '../generated/prisma/enums';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import { ProviderApplicationCurationService } from '../applications/provider-application-curation.service';
import { applicationProcessAllowsMutation } from '../applications/application-process.policy';
import {
  ApplicationViewingPolicy,
  CORRECTION_WINDOW_MS,
} from './application-viewing.policy';
import type {
  WorkflowInterestDto,
  WorkflowConsiderationDto,
  WorkflowOutcomeDto,
} from './dto/workflow-command.dto';

export type ViewingDecisionCommand =
  | { action: 'interest'; appointmentId: string; body: WorkflowInterestDto }
  | {
      action: 'consideration';
      appointmentId: string;
      body: WorkflowConsiderationDto;
    }
  | { action: 'outcome'; appointmentId: string; body: WorkflowOutcomeDto };

@Injectable()
export class ViewingWorkflowDecisionService {
  constructor(
    private readonly lifecycle: ApplicationLifecycleService,
    private readonly curation: ProviderApplicationCurationService,
    private readonly activity: ApplicationActivityService,
    private readonly policy: ApplicationViewingPolicy,
    private readonly consideration: ApplicationConsiderationService,
  ) {}

  async apply(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: 'provider' | 'applicant',
    command: ViewingDecisionCommand,
    now: Date,
  ) {
    const w = await tx.viewingWorkflow.findUniqueOrThrow({
      where: { applicationId },
    });
    const a = await tx.viewingAppointment.findFirst({
      where: { viewingId: command.appointmentId, workflowId: w.id },
      include: {
        viewing: {
          include: {
            outcomes: { orderBy: { revision: 'asc' } },
            interest: true,
          },
        },
      },
    });
    const changed = (reason: string): never => {
      throw new ConflictException({
        statusCode: 409,
        code: 'VIEWING_STATE_CHANGED',
        applicationId,
        reason,
        currentWorkflowRevision: w.revision,
      });
    };
    if (!a) return changed('APPOINTMENT_IS_NOT_CURRENT');
    const app = await tx.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: { listing: { select: { status: true } } },
    });
    const active = applicationProcessAllowsMutation(app);
    const postViewingOpen =
      w.state === 'OPEN' || w.closureReason === 'PROVIDER_CLOSED';
    const latest = await tx.applicationViewing.findFirst({
      where: { applicationId, acceptedAt: { not: null } },
      orderBy: { round: 'desc' },
      select: { id: true },
    });
    const isLatest = latest?.id === a.viewingId;
    if (command.action !== 'outcome') {
      const completed = await tx.applicationViewing.findFirst({
        where: { applicationId, status: 'COMPLETED' },
        orderBy: { round: 'desc' },
        select: { id: true },
      });
      if (completed?.id !== a.viewingId) changed('APPOINTMENT_IS_NOT_CURRENT');
    }
    let event: Event;
    let lifecycleBumped = false;
    if (command.action === 'outcome') {
      if (side !== 'provider') changed('ACTION_NOT_ALLOWED_FOR_SIDE');
      if (now < a.viewing.endsAt) changed('APPOINTMENT_NOT_ENDED');
      const dto = command.body;
      const first = a.viewing.outcomes[0];
      const correction = dto.correctionReason !== undefined;
      if (
        correction
          ? !isLatest ||
            !first ||
            a.viewing.outcomes.length !== 1 ||
            a.viewing.interest ||
            now.getTime() >=
              first.recordedAt.getTime() + CORRECTION_WINDOW_MS ||
            (first.outcome === dto.outcome &&
              first.absenceSide === (dto.absenceSide ?? null))
          : !['ACCEPTED', 'OUTCOME_PENDING'].includes(a.viewing.status) || first
      )
        changed('OUTCOME_OPERATION_NOT_ALLOWED');
      if (
        dto.outcome === 'NO_SHOW'
          ? !dto.absenceSide
          : dto.absenceSide !== undefined
      )
        throw new BadRequestException(
          'No-show requires absenceSide; completed cannot include it',
        );
      const recorded = await tx.applicationViewingOutcome.create({
        data: {
          viewingId: a.viewingId,
          revision: correction ? 2 : 1,
          outcome: dto.outcome,
          absenceSide: dto.absenceSide,
          correctionReason: correction
            ? this.policy.text(dto.correctionReason)
            : null,
          recordedAt: now,
        },
      });
      await tx.applicationViewing.update({
        where: { id: a.viewingId },
        data: { status: dto.outcome },
      });
      await this.consideration.outcomeWithinTransaction(tx, {
        applicationId,
        listingId: app.listingId,
        outcomeId: recorded.id,
        previousOutcomeId: correction ? first?.id : undefined,
        penalize:
          active &&
          isLatest &&
          w.state === 'OPEN' &&
          dto.outcome === 'NO_SHOW' &&
          dto.absenceSide === 'APPLICANT' &&
          (correction ||
            (a.viewing.status === 'ACCEPTED' &&
              w.confirmedAppointmentId === a.viewingId)),
        now,
      });
      // A newer completion closes earlier requests; an old deadline cannot reject later interest.
      if (isLatest)
        await tx.viewingAppointment.updateMany({
          where: {
            workflowId: w.id,
            interestState: { in: ['PENDING', 'LEGACY_UNANSWERED'] },
          },
          data: { interestState: 'CLOSED', interestClosedAt: now },
        });
      if (dto.outcome === 'COMPLETED')
        await tx.viewingAppointment.update({
          where: { viewingId: a.viewingId },
          data:
            active &&
            isLatest &&
            postViewingOpen &&
            a.interestState !== 'CLOSED' &&
            a.viewing.status !== 'OUTCOME_PENDING'
              ? {
                  interestState: 'PENDING',
                  interestRequestedAt: now,
                  interestDeadlineAt: new Date(
                    now.getTime() + 48 * 60 * 60_000,
                  ),
                  interestClosedAt: null,
                }
              : { interestState: 'CLOSED', interestClosedAt: now },
        });
      else if (
        a.interestState === 'PENDING' ||
        a.interestState === 'LEGACY_UNANSWERED'
      )
        await tx.viewingAppointment.update({
          where: { viewingId: a.viewingId },
          data: { interestState: 'CLOSED', interestClosedAt: now },
        });
      const ownsCommitment = w.confirmedAppointmentId === a.viewingId;
      if (ownsCommitment && w.pendingProposalId)
        await tx.viewingProposal.update({
          where: { id: w.pendingProposalId },
          data: {
            resolution: 'CLOSED',
            resolvedBy: Actor.PROVIDER,
            resolvedAt: now,
          },
        });
      await tx.viewingWorkflow.update({
        where: { id: w.id },
        data: {
          ...(ownsCommitment
            ? { pendingProposalId: null, confirmedAppointmentId: null }
            : {}),
          revision: { increment: 1 },
          updatedAt: now,
        },
      });
      event = correction
        ? Event.VIEWING_OUTCOME_CORRECTED
        : dto.outcome === 'COMPLETED'
          ? Event.VIEWING_COMPLETED
          : Event.VIEWING_NO_SHOW;
    } else if (command.action === 'interest') {
      if (side !== 'applicant' || !active)
        changed('APPLICATION_PROCESS_INACTIVE');
      if (
        !postViewingOpen ||
        a.viewing.status !== 'COMPLETED' ||
        (a.interestState !== 'LEGACY_UNANSWERED' &&
          (a.interestState !== 'PENDING' ||
            !a.interestDeadlineAt ||
            now >= a.interestDeadlineAt))
      )
        changed('INTEREST_RESPONSE_UNAVAILABLE');
      if (
        command.body.interest === 'NOT_INTERESTED' &&
        command.body.confirmWithdrawal !== true
      )
        throw new BadRequestException('Withdrawal confirmation required');
      await tx.applicationViewingInterest.create({
        data: {
          viewingId: a.viewingId,
          interest: command.body.interest,
          respondedAt: now,
        },
      });
      await tx.viewingAppointment.update({
        where: { viewingId: a.viewingId },
        data: { interestState: command.body.interest },
      });
      event =
        command.body.interest === 'NOT_INTERESTED'
          ? Event.VIEWING_INTEREST_DECLINED
          : Event.VIEWING_INTEREST_CONFIRMED;
      if (command.body.interest === 'NOT_INTERESTED') {
        await this.lifecycle.withdrawWithinTransaction(
          tx,
          applicationId,
          userId,
        );
        lifecycleBumped = true;
      }
    } else {
      if (side !== 'provider' || !active)
        changed('APPLICATION_PROCESS_INACTIVE');
      if (a.viewing.status !== 'COMPLETED')
        changed('CONSIDERATION_REQUIRES_COMPLETED_VIEWING');
      if (!postViewingOpen || a.interestState === 'CLOSED')
        changed('POST_VIEWING_DECISION_CLOSED');
      // The existing rejection helper owns cooldown, activity, capacity and promotion.
      if (command.body.consideration === 'DO_NOT_CONTINUE') {
        await this.curation.rejectWithinTransaction(
          tx,
          applicationId,
          userId,
          true,
        );
        lifecycleBumped = true;
      } else
        await tx.viewingWorkflow.update({
          where: { id: w.id },
          data: {
            providerConsideration: command.body.consideration,
            considerationDecidedAt: now,
            revision: { increment: 1 },
            updatedAt: now,
          },
        });
      event = Event.VIEWING_CONSIDERATION_CHANGED;
    }
    if (command.action === 'interest' && !lifecycleBumped)
      await tx.viewingWorkflow.update({
        where: { id: w.id },
        data: { revision: { increment: 1 }, updatedAt: now },
      });
    const current = await tx.viewingWorkflow.findUniqueOrThrow({
      where: { id: w.id },
    });
    await this.activity.appendWithinTransaction(tx, {
      applicationId,
      actorUserId: userId,
      actorType: side === 'provider' ? Actor.PROVIDER : Actor.APPLICANT,
      type: event,
      visibility: 'BOTH',
      occurredAt: now,
      metadata: {
        workflowId: w.id,
        workflowRevision: current.revision,
        appointmentId: a.viewingId,
        viewingId: a.viewingId,
        providerConsideration:
          command.action === 'consideration'
            ? command.body.consideration
            : undefined,
        outcomeRevision:
          command.action === 'outcome'
            ? a.viewing.outcomes.length + 1
            : undefined,
      },
    });
    return {
      applicationId,
      workflowId: w.id,
      workflowRevision: current.revision,
      proposalId: null,
      appointmentId: a.viewingId,
    };
  }
}
