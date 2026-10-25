import { ApplicationOutboxProducer } from '../outbox/application-outbox.producer';
import { ViewingWorkflowExpiryService } from './viewing-workflow-expiry.service';
import { ApplicationViewingReadService } from './application-viewing-read.service';
import { projectViewingWorkflow } from './viewing-workflow-projection';
import { createHash } from 'node:crypto';
import { ViewingLifecycleService } from '../applications/viewing-lifecycle.service';
import type { ViewingClosureReason } from '../generated/prisma/enums';
import {
  ViewingWorkflowDecisionService,
  type ViewingDecisionCommand,
} from './viewing-workflow-decision.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma, ViewingProposal } from '../generated/prisma/client';
import {
  ApplicationActivityActorType as Actor,
  ApplicationActivityType as Event,
  ApplicationActivityVisibility,
  ApplicationViewingStatus as Status,
  ViewingCancellationReason as Cancellation,
  ViewingProposalResolution as Resolution,
} from '../generated/prisma/enums';
import {
  ApplicationActivityService,
  type ApplicationActivityMetadata,
} from '../applications/application-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import {
  ApplicationViewingAccessService,
  type ViewingAudience,
} from './application-viewing-access.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
} from './application-viewing.policy';
import {
  ViewingWorkflowCommandPolicy,
  VIEWING_CHANGE_CUTOFF_MS,
} from './viewing-workflow-command.policy';
import type {
  WorkflowCommandDto,
  WorkflowScheduleDto,
  WorkflowCancelDto,
  WorkflowCloseDto,
} from './dto/workflow-command.dto';

export type ViewingWorkflowCommand =
  | ViewingDecisionCommand
  | { action: 'reconcile'; body: WorkflowCommandDto }
  | { action: 'invite'; body: WorkflowScheduleDto }
  | {
      action: 'accept' | 'reject' | 'withdraw';
      proposalId: string;
      body: WorkflowCommandDto;
    }
  | {
      action: 'counterproposal' | 'alternative-proposal';
      proposalId: string;
      body: WorkflowScheduleDto;
    }
  | {
      action: 'replacement' | 'alternative-appointment';
      appointmentId: string;
      body: WorkflowScheduleDto;
    }
  | { action: 'cancel'; appointmentId: string; body: WorkflowCancelDto }
  | { action: 'close'; workflowId: string; body: WorkflowCloseDto };

const workflowInclude = {
  pendingProposal: true,
  confirmedAppointment: { include: { viewing: true } },
} satisfies Prisma.ViewingWorkflowInclude;
type Workflow = Prisma.ViewingWorkflowGetPayload<{
  include: typeof workflowInclude;
}>;
type Result = {
  applicationId: string;
  workflowId: string | null;
  workflowRevision: number;
  proposalId: string | null;
  appointmentId: string | null;
};
type Failure = {
  statusCode: 409;
  code: 'VIEWING_STATE_CHANGED';
  applicationId: string;
  reason: string;
  currentWorkflowRevision: number;
};
type Outcome = { ok: true; result: Result } | { ok: false; error: Failure };

function object(
  value: Prisma.JsonValue | undefined,
): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integrityFailure(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  const record = value as Record<string, unknown>;
  return (
    record.code === '23514' ||
    record.originalCode === '23514' ||
    ['meta', 'cause', 'driverAdapterError'].some((key) =>
      integrityFailure(record[key], depth + 1),
    )
  );
}

@Injectable()
export class ViewingWorkflowCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invalidation: ApplicationOutboxProducer,
    private readonly reads: ApplicationViewingReadService,
    private readonly access: ApplicationViewingAccessService,
    private readonly policy: ViewingWorkflowCommandPolicy,
    private readonly text: ApplicationViewingPolicy,
    private readonly clock: ViewingClock,
    private readonly activity: ApplicationActivityService,
    private readonly decisions: ViewingWorkflowDecisionService,
    private readonly lifecycleClosure: ViewingLifecycleService,
    private readonly expiry: ViewingWorkflowExpiryService,
  ) {}

  private load(tx: Prisma.TransactionClient, applicationId: string) {
    return tx.viewingWorkflow.findUnique({
      where: { applicationId },
      include: workflowInclude,
    });
  }

  async snapshot(applicationId: string, userId: string, side: ViewingAudience) {
    return this.prisma.$transaction(
      async (tx) => {
        const app = await this.access.authorize(
          tx,
          applicationId,
          userId,
          side,
        );
        const now = this.clock.now();
        const facts = await this.reads.batch(tx, [applicationId]);
        const source = facts.workflows.get(applicationId)!;
        const projection = projectViewingWorkflow(
          applicationId,
          source,
          this.access.canMutate(app),
          side,
          now,
        );
        return {
          ...projection,
          state: projection.closure?.state ?? null,
          mutationsBlockedReason: this.access.canMutate(app)
            ? null
            : 'APPLICATION_PROCESS_INACTIVE',
          postViewing: projection.applicantInterest
            ? {
                appointmentId: projection.applicantInterest.appointmentId,
                interestState: projection.applicantInterest.storedState,
                interestDeadlineAt: projection.applicantInterest.deadlineAt,
                providerConsideration: projection.providerConsideration?.state,
                interestResponseBlockedReason: projectViewingWorkflow(
                  applicationId,
                  source,
                  this.access.canMutate(app),
                  'applicant',
                  now,
                ).capabilities.find((c) => c.action === 'SUBMIT_INTEREST')
                  ?.blockedReason,
              }
            : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private failure(
    applicationId: string,
    revision: number,
    reason: string,
  ): Failure {
    return {
      statusCode: 409,
      code: 'VIEWING_STATE_CHANGED',
      applicationId,
      reason,
      currentWorkflowRevision: revision,
    };
  }

  private changed(
    w: Pick<Workflow, 'applicationId' | 'revision'>,
    reason: string,
  ): never {
    throw new ConflictException(
      this.failure(w.applicationId, w.revision, reason),
    );
  }

  private receiptOutcome(value: Prisma.JsonValue): Outcome {
    if (object(value) && value.ok === true && object(value.result)) {
      const r = value.result;
      if (
        typeof r.applicationId === 'string' &&
        (typeof r.workflowId === 'string' || r.workflowId === null) &&
        typeof r.workflowRevision === 'number' &&
        Number.isInteger(r.workflowRevision) &&
        (typeof r.proposalId === 'string' || r.proposalId === null) &&
        (typeof r.appointmentId === 'string' || r.appointmentId === null)
      )
        return {
          ok: true,
          result: {
            applicationId: r.applicationId,
            workflowId: r.workflowId,
            workflowRevision: r.workflowRevision,
            proposalId: r.proposalId,
            appointmentId: r.appointmentId,
          },
        };
    }
    if (object(value) && value.ok === false && object(value.error)) {
      const e = value.error;
      if (
        e.code === 'VIEWING_STATE_CHANGED' &&
        typeof e.applicationId === 'string' &&
        typeof e.reason === 'string' &&
        typeof e.currentWorkflowRevision === 'number'
      )
        return {
          ok: false,
          error: this.failure(
            e.applicationId,
            e.currentWorkflowRevision,
            e.reason,
          ),
        };
    }
    throw new Error('Invalid persisted viewing command result');
  }

  private hash(command: ViewingWorkflowCommand, side: ViewingAudience) {
    const body = command.body;
    const payload =
      command.action === 'interest'
        ? {
            interest: command.body.interest,
            confirmWithdrawal: command.body.confirmWithdrawal ?? false,
          }
        : command.action === 'consideration'
          ? { consideration: command.body.consideration }
          : command.action === 'outcome'
            ? {
                outcome: command.body.outcome,
                absenceSide: command.body.absenceSide ?? null,
                correctionReason: this.text.text(command.body.correctionReason),
              }
            : 'startsAt' in body
              ? this.policy.canonicalSchedule(body)
              : {
                  message:
                    'message' in body ? this.text.text(body.message) : null,
                };
    return createHash('sha256')
      .update(
        JSON.stringify({
          action: command.action,
          side,
          expectedWorkflowRevision: body.expectedWorkflowRevision,
          proposalId: 'proposalId' in command ? command.proposalId : null,
          appointmentId:
            'appointmentId' in command ? command.appointmentId : null,
          workflowId: 'workflowId' in command ? command.workflowId : null,
          close:
            command.action === 'close'
              ? {
                  reason: command.body.reason,
                  proposalId: command.body.proposalId,
                  appointmentId: command.body.appointmentId,
                }
              : null,
          payload,
        }),
      )
      .digest('hex');
  }

  async execute(
    applicationId: string,
    userId: string,
    side: ViewingAudience,
    command: ViewingWorkflowCommand,
  ): Promise<Result> {
    const hash = this.hash(command, side);
    const outcome = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const app = await this.access.lock(tx, applicationId, userId, side);
        const receipt = await tx.viewingCommandReceipt.findUnique({
          where: {
            applicationId_requestKey: {
              applicationId,
              requestKey: command.body.requestKey,
            },
          },
        });
        if (receipt) {
          if (
            receipt.requestHash !== hash ||
            receipt.actorUserId !== userId ||
            receipt.command !== command.action
          )
            throw new ConflictException({
              code: 'VIEWING_IDEMPOTENCY_KEY_REUSED',
              message: 'Request key was used with different input or actor',
            });
          return this.receiptOutcome(receipt.outcome);
        }
        let w = await this.load(tx, applicationId);
        const revision = w?.revision ?? 0;
        if (
          !this.access.canMutate(app) &&
          command.action !== 'outcome' &&
          !(command.action === 'reconcile' && app.status !== 'WAITING')
        )
          throw new ConflictException(
            this.failure(
              applicationId,
              revision,
              'APPLICATION_PROCESS_INACTIVE',
            ),
          );
        if (command.body.expectedWorkflowRevision !== revision)
          throw new ConflictException(
            this.failure(applicationId, revision, 'STALE_REVISION'),
          );
        const now = this.clock.now();
        let result: Result;
        if (command.action === 'reconcile') {
          const beforeReconcileRevision = w?.revision;
          const beforeReconcileMode = w?.mode;
          const closedLegacy = w?.mode === 'LEGACY' && w.state === 'CLOSED';
          const legacyClosedAt = w?.closedAt;
          try {
            await tx.$queryRaw`SELECT reconcile_legacy_viewing_workflow(${applicationId}::uuid)`;
          } catch (error) {
            if (integrityFailure(error))
              throw new ConflictException(
                this.failure(
                  applicationId,
                  revision,
                  'LEGACY_RECONCILIATION_FAILED',
                ),
              );
            throw error;
          }
          w = await this.load(tx, applicationId);
          // Import may reconstruct unanswered legacy interest; a recorded lifecycle
          // closure remains authoritative even after the application was restored.
          if (w && closedLegacy)
            await tx.viewingAppointment.updateMany({
              where: {
                workflowId: w.id,
                interestState: {
                  in: ['PENDING', 'LEGACY_UNANSWERED', 'NOT_REQUESTED'],
                },
              },
              data: {
                interestState: 'CLOSED',
                interestClosedAt: legacyClosedAt ?? now,
              },
            });
          // Reconciliation of a pre-integration terminal application cannot restore commitments.
          if (w && !this.access.canMutate(app)) {
            const reason: ViewingClosureReason =
              app.status === 'WITHDRAWN'
                ? 'APPLICATION_WITHDRAWN'
                : app.status === 'ACCEPTED'
                  ? 'APPLICATION_ACCEPTED'
                  : app.status === 'REJECTED'
                    ? 'APPLICATION_REJECTED'
                    : app.listing.status === 'RENTED'
                      ? 'LISTING_RENTED'
                      : app.listing.status === 'ARCHIVED'
                        ? 'LISTING_ARCHIVED'
                        : 'LISTING_UNPUBLISHED';
            await this.lifecycleClosure.closeWithinTransaction(
              tx,
              applicationId,
              reason,
              Actor.SYSTEM,
            );
            w = await this.load(tx, applicationId);
          }
          if (
            w &&
            (beforeReconcileMode !== w.mode ||
              beforeReconcileRevision !== w.revision)
          )
            await this.invalidation.viewing(tx, applicationId, now, {
              workflowId: w.id,
              workflowRevision: w.revision,
            });
          result = {
            applicationId,
            workflowId: w?.id ?? null,
            workflowRevision: w?.revision ?? 0,
            proposalId: null,
            appointmentId: null,
          };
        } else {
          if (
            w?.mode === 'LEGACY' ||
            (!w &&
              (await tx.applicationViewing.count({
                where: { applicationId },
              })) > 0)
          )
            throw new ConflictException(
              this.failure(
                applicationId,
                revision,
                'LEGACY_RECONCILIATION_REQUIRED',
              ),
            );
          if (!w) {
            if (command.action !== 'invite' || side !== 'provider')
              throw new ConflictException(
                this.failure(applicationId, 0, 'PROVIDER_INVITATION_REQUIRED'),
              );
            w = await tx.viewingWorkflow.create({
              data: { applicationId, createdAt: now, updatedAt: now },
              include: workflowInclude,
            });
          }
          // Persist an overdue lifecycle decision before applying a newer intent.
          // Return a committed conflict, rather than rolling expiry back by throwing.
          if (
            await this.expiry.interestWithinTransaction(tx, applicationId, now)
          ) {
            const current = await this.load(tx, applicationId);
            const failed: Outcome = {
              ok: false,
              error: this.failure(
                applicationId,
                current!.revision,
                'INTEREST_RESPONSE_EXPIRED',
              ),
            };
            await this.save(
              tx,
              applicationId,
              userId,
              side,
              command,
              hash,
              failed,
              now,
            );
            return failed;
          }
          if (
            command.action === 'interest' ||
            command.action === 'consideration' ||
            command.action === 'outcome'
          ) {
            result = await this.decisions.apply(
              tx,
              applicationId,
              userId,
              side,
              command,
              now,
            );
            const succeeded: Outcome = { ok: true, result };
            await this.save(
              tx,
              applicationId,
              userId,
              side,
              command,
              hash,
              succeeded,
              now,
            );
            return succeeded;
          }
          const pending = w.pendingProposal;
          // Validate exact intent before opportunistic expiry can mutate any row.
          if ('proposalId' in command) this.pending(w, command.proposalId);
          if (
            'appointmentId' in command &&
            w.confirmedAppointmentId !== command.appointmentId
          )
            this.changed(w, 'APPOINTMENT_IS_NOT_CURRENT');
          if (
            command.action === 'close' &&
            (w.id !== command.workflowId ||
              w.pendingProposalId !== command.body.proposalId ||
              w.confirmedAppointmentId !== command.body.appointmentId)
          )
            this.changed(w, 'CLOSE_TARGETS_CHANGED');
          if (
            pending &&
            (await this.expiry.proposalWithinTransaction(
              tx,
              applicationId,
              pending.id,
              now,
            ))
          ) {
            const failed: Outcome = {
              ok: false,
              error: this.failure(
                applicationId,
                w.revision + 1,
                'PROPOSAL_EXPIRED',
              ),
            };
            await this.save(
              tx,
              applicationId,
              userId,
              side,
              command,
              hash,
              failed,
              now,
            );
            return failed;
          }
          result = await this.apply(tx, w, userId, side, command, now);
        }
        const succeeded: Outcome = { ok: true, result };
        await this.save(
          tx,
          applicationId,
          userId,
          side,
          command,
          hash,
          succeeded,
          now,
        );
        return succeeded;
      },
    );
    // Expiry is committed, even though the triggering stale command receives 409.
    if (!outcome.ok) throw new ConflictException(outcome.error);
    return outcome.result;
  }

  private save(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ViewingAudience,
    command: ViewingWorkflowCommand,
    hash: string,
    outcome: Outcome,
    now: Date,
  ) {
    return tx.viewingCommandReceipt.create({
      data: {
        applicationId,
        requestKey: command.body.requestKey,
        actorUserId: userId,
        actorSide: side === 'provider' ? 'PROVIDER' : 'APPLICANT',
        command: command.action,
        requestHash: hash,
        outcome,
        createdAt: now,
      },
    });
  }

  private async bump(
    tx: Prisma.TransactionClient,
    w: Workflow,
    patch: Prisma.ViewingWorkflowUncheckedUpdateManyInput,
    now: Date,
  ) {
    const updated = await tx.viewingWorkflow.updateMany({
      where: { id: w.id, revision: w.revision },
      data: { ...patch, revision: { increment: 1 }, updatedAt: now },
    });
    if (updated.count !== 1) this.changed(w, 'STALE_REVISION');
  }

  private event(
    tx: Prisma.TransactionClient,
    w: Workflow,
    userId: string | undefined,
    actorType: Actor,
    type: Event,
    now: Date,
    metadata: ApplicationActivityMetadata = {},
  ) {
    return this.activity.appendWithinTransaction(tx, {
      applicationId: w.applicationId,
      actorUserId: userId,
      actorType,
      visibility: ApplicationActivityVisibility.BOTH,
      type,
      occurredAt: now,
      metadata: {
        ...metadata,
        workflowId: w.id,
        workflowRevision: w.revision + 1,
      },
    });
  }

  private async resolve(
    tx: Prisma.TransactionClient,
    p: ViewingProposal,
    resolution: Resolution,
    actor: Actor,
    now: Date,
  ) {
    await tx.viewingProposal.update({
      where: { id: p.id },
      data: { resolution, resolvedAt: now, resolvedBy: actor },
    });
    // Retire the old unresolved placeholder when an actual new action replaces it.
    // Keep legacy IDs and all existing outcome/activity records intact.
    if (p.timing === 'LEGACY' && resolution !== Resolution.ACCEPTED) {
      const data =
        resolution === Resolution.DECLINED
          ? { status: Status.DECLINED, declinedAt: now }
          : resolution === Resolution.SUPERSEDED
            ? { status: Status.SUPERSEDED, supersededAt: now }
            : { status: Status.CANCELLED, cancelledAt: now };
      await tx.applicationViewing.updateMany({
        where: { id: p.id, status: Status.PROPOSED },
        data,
      });
    }
  }

  private pending(w: Workflow, id: string) {
    if (!w.pendingProposal || w.pendingProposalId !== id)
      this.changed(w, 'PROPOSAL_IS_NOT_CURRENT');
    return w.pendingProposal;
  }

  private appointment(w: Workflow, id: string, now: Date) {
    if (!w.confirmedAppointment || w.confirmedAppointmentId !== id)
      this.changed(w, 'APPOINTMENT_IS_NOT_CURRENT');
    if (now >= w.confirmedAppointment.viewing.startsAt)
      this.changed(w, 'APPOINTMENT_ALREADY_STARTED');
    return w.confirmedAppointment;
  }

  private async newProposal(
    tx: Prisma.TransactionClient,
    w: Workflow,
    dto: WorkflowScheduleDto,
    side: ViewingAudience,
    now: Date,
    predecessor: string | null,
    base: Workflow['confirmedAppointment'],
  ) {
    const schedule = this.policy.schedule(
      dto,
      side,
      now,
      base?.viewing.startsAt,
    );
    if (
      base &&
      schedule.startsAt.getTime() === base.viewing.startsAt.getTime() &&
      schedule.endsAt.getTime() === base.viewing.endsAt.getTime()
    )
      throw new BadRequestException(
        'An alternative must propose a different appointment',
      );
    const duplicate = await tx.viewingProposal.findUnique({
      where: {
        workflowId_requestKey: { workflowId: w.id, requestKey: dto.requestKey },
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException({ code: 'VIEWING_IDEMPOTENCY_KEY_REUSED' });
    const latest = await tx.viewingProposal.aggregate({
      where: { workflowId: w.id },
      _max: { round: true },
    });
    return tx.viewingProposal.create({
      data: {
        workflowId: w.id,
        round: (latest._max.round ?? 0) + 1,
        proposerSide: side === 'provider' ? 'PROVIDER' : 'APPLICANT',
        responderSide: side === 'provider' ? 'APPLICANT' : 'PROVIDER',
        ...schedule,
        predecessorProposalId: predecessor,
        baseAppointmentId: base?.viewingId ?? null,
        requestKey: dto.requestKey,
        requestHash: createHash('sha256')
          .update(JSON.stringify(this.policy.canonicalSchedule(dto)))
          .digest('hex'),
        createdAt: now,
      },
    });
  }

  private async cancelAppointment(
    tx: Prisma.TransactionClient,
    w: Workflow,
    side: ViewingAudience,
    reason: Cancellation,
    message: string | undefined,
    now: Date,
  ) {
    const a = w.confirmedAppointment;
    if (!a) return;
    this.appointment(w, a.viewingId, now);
    await tx.applicationViewing.update({
      where: { id: a.viewingId },
      data: { status: Status.CANCELLED, cancelledAt: now },
    });
    await tx.viewingAppointment.update({
      where: { viewingId: a.viewingId },
      data: {
        cancelledBy: side === 'provider' ? Actor.PROVIDER : Actor.APPLICANT,
        cancellationReason: reason,
        cancellationNote: this.text.text(message),
        lateCancellation:
          now.getTime() >=
          a.viewing.startsAt.getTime() - VIEWING_CHANGE_CUTOFF_MS,
      },
    });
  }

  private async apply(
    tx: Prisma.TransactionClient,
    w: Workflow,
    userId: string,
    side: ViewingAudience,
    command: Exclude<
      ViewingWorkflowCommand,
      ViewingDecisionCommand | { action: 'reconcile' }
    >,
    now: Date,
  ): Promise<Result> {
    const actor = side === 'provider' ? Actor.PROVIDER : Actor.APPLICANT;
    const patch: Prisma.ViewingWorkflowUncheckedUpdateManyInput = {};
    let proposalId: string | null = null;
    let appointmentId: string | null = null;
    const requireSide = (required: ViewingAudience) => {
      if (side !== required) this.changed(w, 'ACTION_NOT_ALLOWED_FOR_SIDE');
    };
    const applicantCutoff = () => {
      if (
        w.confirmedAppointment &&
        now.getTime() >=
          w.confirmedAppointment.viewing.startsAt.getTime() -
            VIEWING_CHANGE_CUTOFF_MS
      )
        this.changed(w, 'APPLICANT_CHANGE_CUTOFF_PASSED');
    };
    switch (command.action) {
      case 'invite': {
        requireSide('provider');
        if (w.pendingProposalId || w.confirmedAppointmentId)
          this.changed(w, 'VIEWING_ALREADY_PENDING_OR_CONFIRMED');
        // A restored/pre-fix closed workflow starts a fresh invitation cycle.
        // Do not carry an old unanswered decision into the reopened workflow.
        if (w.state === 'CLOSED')
          await tx.viewingAppointment.updateMany({
            where: {
              workflowId: w.id,
              interestState: {
                in: ['PENDING', 'LEGACY_UNANSWERED', 'NOT_REQUESTED'],
              },
            },
            data: { interestState: 'CLOSED', interestClosedAt: now },
          });
        const p = await this.newProposal(
          tx,
          w,
          command.body,
          side,
          now,
          null,
          null,
        );
        proposalId = p.id;
        patch.pendingProposalId = p.id;
        patch.state = 'OPEN';
        patch.closedAt = null;
        patch.closureReason = null;
        await this.event(tx, w, userId, actor, Event.VIEWING_PROPOSED, now, {
          proposalId: p.id,
          viewingRound: p.round,
          startsAt: p.startsAt.toISOString(),
          endsAt: p.endsAt.toISOString(),
        });
        break;
      }
      case 'accept':
      case 'reject': {
        const p = this.pending(w, command.proposalId);
        if (
          p.responderSide !== (side === 'provider' ? 'PROVIDER' : 'APPLICANT')
        )
          this.changed(w, 'ONLY_RESPONDER_CAN_DECIDE');
        if (now >= p.startsAt) this.changed(w, 'PROPOSAL_ALREADY_STARTED');
        proposalId = p.id;
        if (command.action === 'reject') {
          await this.resolve(tx, p, Resolution.DECLINED, actor, now);
          patch.pendingProposalId = null;
          await this.event(tx, w, userId, actor, Event.VIEWING_DECLINED, now, {
            proposalId: p.id,
          });
          break;
        }
        if (p.timing === 'LEGACY' || !p.responseDeadlineAt)
          this.changed(w, 'LEGACY_INVITATION_REQUIRES_REISSUE');
        if (w.confirmedAppointment) {
          this.appointment(w, w.confirmedAppointment.viewingId, now);
          await tx.applicationViewing.update({
            where: { id: w.confirmedAppointment.viewingId },
            data: { status: Status.SUPERSEDED, supersededAt: now },
          });
        }
        await this.resolve(tx, p, Resolution.ACCEPTED, actor, now);
        await tx.applicationViewing.create({
          data: {
            id: p.id,
            applicationId: w.applicationId,
            round: p.round,
            status: Status.ACCEPTED,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            timeZone: p.timeZone,
            providerNote: p.proposerSide === 'PROVIDER' ? p.message : null,
            acceptedAt: now,
            requestKey: p.requestKey,
            requestHash: p.requestHash,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.viewingAppointment.create({
          data: { viewingId: p.id, workflowId: w.id, proposalId: p.id },
        });
        appointmentId = p.id;
        patch.confirmedAppointmentId = p.id;
        patch.pendingProposalId = null;
        await this.event(tx, w, userId, actor, Event.VIEWING_ACCEPTED, now, {
          proposalId: p.id,
          appointmentId: p.id,
          viewingId: p.id,
        });
        if (w.confirmedAppointmentId)
          await this.event(
            tx,
            w,
            userId,
            actor,
            Event.VIEWING_RESCHEDULED,
            now,
            {
              proposalId: p.id,
              appointmentId: p.id,
              previousAppointmentId: w.confirmedAppointmentId,
            },
          );
        break;
      }
      case 'alternative-proposal':
      case 'counterproposal': {
        const p = this.pending(w, command.proposalId);
        if (command.action === 'alternative-proposal') {
          requireSide('applicant');
          applicantCutoff();
          if (p.proposerSide !== 'PROVIDER' || now >= p.startsAt)
            this.changed(w, 'PROVIDER_INVITATION_REQUIRED');
          const candidate = this.policy.canonicalSchedule(command.body);
          if (
            candidate.startsAt === p.startsAt.toISOString() &&
            candidate.endsAt === p.endsAt.toISOString()
          )
            throw new BadRequestException(
              'An alternative must propose a different appointment',
            );
        } else requireSide('provider');
        if (w.confirmedAppointmentId)
          this.appointment(w, w.confirmedAppointmentId, now);
        await this.resolve(
          tx,
          p,
          command.action === 'counterproposal' && p.proposerSide === 'APPLICANT'
            ? Resolution.DECLINED
            : Resolution.SUPERSEDED,
          actor,
          now,
        );
        if (
          command.action === 'counterproposal' &&
          p.proposerSide === 'APPLICANT'
        )
          await this.event(tx, w, userId, actor, Event.VIEWING_DECLINED, now, {
            proposalId: p.id,
            counterproposal: true,
          });
        const next = await this.newProposal(
          tx,
          w,
          command.body,
          side,
          now,
          p.id,
          w.confirmedAppointment,
        );
        proposalId = next.id;
        patch.pendingProposalId = next.id;
        await this.event(
          tx,
          w,
          userId,
          actor,
          side === 'applicant'
            ? Event.VIEWING_CHANGE_REQUESTED
            : Event.VIEWING_REPLACEMENT_PROPOSED,
          now,
          {
            proposalId: next.id,
            previousProposalId: p.id,
            viewingRound: next.round,
          },
        );
        break;
      }
      case 'replacement':
      case 'alternative-appointment': {
        if (command.action === 'replacement') requireSide('provider');
        else {
          requireSide('applicant');
          applicantCutoff();
        }
        const a = this.appointment(w, command.appointmentId, now);
        if (w.pendingProposalId)
          this.changed(w, 'PENDING_PROPOSAL_MUST_BE_RESOLVED');
        const next = await this.newProposal(
          tx,
          w,
          command.body,
          side,
          now,
          a.proposalId,
          a,
        );
        proposalId = next.id;
        appointmentId = a.viewingId;
        patch.pendingProposalId = next.id;
        await this.event(
          tx,
          w,
          userId,
          actor,
          side === 'provider'
            ? Event.VIEWING_REPLACEMENT_PROPOSED
            : Event.VIEWING_CHANGE_REQUESTED,
          now,
          {
            proposalId: next.id,
            appointmentId: a.viewingId,
            viewingRound: next.round,
          },
        );
        break;
      }
      case 'withdraw': {
        requireSide('applicant');
        const p = this.pending(w, command.proposalId);
        if (p.proposerSide !== 'APPLICANT')
          this.changed(w, 'ONLY_OWN_ALTERNATIVE_CAN_BE_WITHDRAWN');
        await this.resolve(tx, p, Resolution.WITHDRAWN, actor, now);
        proposalId = p.id;
        patch.pendingProposalId = null;
        await this.event(
          tx,
          w,
          userId,
          actor,
          Event.VIEWING_PROPOSAL_WITHDRAWN,
          now,
          { proposalId: p.id },
        );
        break;
      }
      case 'cancel': {
        requireSide('applicant');
        const a = this.appointment(w, command.appointmentId, now);
        if (w.pendingProposal)
          await this.resolve(
            tx,
            w.pendingProposal,
            Resolution.CLOSED,
            actor,
            now,
          );
        await this.cancelAppointment(
          tx,
          w,
          side,
          Cancellation.APPLICANT_CANCELLED,
          command.body.message,
          now,
        );
        appointmentId = a.viewingId;
        patch.confirmedAppointmentId = null;
        patch.pendingProposalId = null;
        await this.event(tx, w, userId, actor, Event.VIEWING_CANCELLED, now, {
          appointmentId,
          viewingId: appointmentId,
          proposalId: w.pendingProposalId ?? undefined,
          cancellationReason: Cancellation.APPLICANT_CANCELLED,
        });
        break;
      }
      case 'close': {
        requireSide('provider');
        if (
          w.id !== command.workflowId ||
          w.pendingProposalId !== command.body.proposalId ||
          w.confirmedAppointmentId !== command.body.appointmentId ||
          w.state !== 'OPEN'
        )
          this.changed(w, 'CLOSE_TARGETS_CHANGED');
        if (!w.pendingProposalId && !w.confirmedAppointmentId)
          this.changed(w, 'NO_OPEN_VIEWING');
        if (
          ![
            Cancellation.PROVIDER_ILLNESS,
            Cancellation.PROVIDER_OPERATIONAL,
            Cancellation.PROPERTY_UNAVAILABLE,
            Cancellation.OTHER,
          ].some((r) => r === command.body.reason)
        )
          throw new BadRequestException(
            'Provider cancellation reason required',
          );
        if (w.pendingProposal)
          await this.resolve(
            tx,
            w.pendingProposal,
            Resolution.CLOSED,
            actor,
            now,
          );
        await this.cancelAppointment(
          tx,
          w,
          side,
          command.body.reason,
          command.body.message,
          now,
        );
        proposalId = w.pendingProposalId;
        appointmentId = w.confirmedAppointmentId;
        patch.pendingProposalId = null;
        patch.confirmedAppointmentId = null;
        patch.state = 'CLOSED';
        patch.closureReason = 'PROVIDER_CLOSED';
        patch.closedAt = now;
        await this.event(tx, w, userId, actor, Event.VIEWING_CANCELLED, now, {
          proposalId: proposalId ?? undefined,
          appointmentId: appointmentId ?? undefined,
          cancellationReason: command.body.reason,
        });
        break;
      }
    }
    await this.bump(tx, w, patch, now);
    return {
      applicationId: w.applicationId,
      workflowId: w.id,
      workflowRevision: w.revision + 1,
      proposalId,
      appointmentId,
    };
  }
}
