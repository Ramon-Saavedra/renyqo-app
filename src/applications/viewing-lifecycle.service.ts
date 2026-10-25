import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType as Actor,
  ApplicationActivityType as Event,
  ApplicationActivityVisibility as Visibility,
  ViewingClosureReason,
} from '../generated/prisma/enums';
import { ViewingClock } from '../application-viewings/application-viewing.policy';
import { ApplicationActivityService } from './application-activity.service';

/** Persistence below application/listing orchestrators; caller owns Serializable retries. */
@Injectable()
export class ViewingLifecycleService {
  constructor(
    private readonly clock: ViewingClock,
    private readonly activity: ApplicationActivityService,
  ) {}

  async closeWithinTransaction(
    tx: Prisma.TransactionClient,
    applicationId: string,
    reason: ViewingClosureReason,
    actor: Actor,
    actorUserId?: string,
    options: {
      consideration?: 'DO_NOT_CONTINUE';
      context?: 'RESTORE_CLEANUP';
    } = {},
  ) {
    const ref = await tx.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { listingId: true, activeAt: true },
    });
    await tx.$queryRaw`SELECT id FROM listings WHERE id=${ref.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM applications WHERE id=${applicationId}::uuid FOR UPDATE`;
    let w = await tx.viewingWorkflow.findUnique({ where: { applicationId } });
    const now = this.clock.now();
    const rows = await tx.applicationViewing.findMany({
      where: { applicationId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
    });
    // A later lifecycle transition cannot rewrite a historical closure. An old
    // legacy snapshot may still need its live ledger commitments cleaned up.
    if (w?.state === 'CLOSED' && rows.length === 0) {
      // Calendar closure can leave a valid earlier post-viewing decision open.
      // Ending the application closes that decision without re-closing history.
      const ended = await tx.viewingAppointment.updateMany({
        where: {
          workflowId: w.id,
          interestState: { in: ['PENDING', 'LEGACY_UNANSWERED'] },
        },
        data: { interestState: 'CLOSED', interestClosedAt: now },
      });
      if (ended.count)
        await tx.viewingWorkflow.update({
          where: { id: w.id },
          data: { revision: { increment: 1 }, updatedAt: now },
        });
      return;
    }
    if (!w) {
      const hasLegacyHistory =
        rows.length > 0 ||
        (await tx.applicationViewing.count({ where: { applicationId } })) > 0;
      if (!hasLegacyHistory) return;
      // Record this real lifecycle closure even when legacy history was never
      // imported. Later restore/cutover must not recreate unanswered interest.
      w = await tx.viewingWorkflow.create({
        data: {
          id: applicationId,
          applicationId,
          mode: 'LEGACY',
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    if (w?.mode === 'CURRENT')
      await tx.viewingProposal.updateMany({
        where: { workflowId: w.id, resolution: 'PENDING' },
        data: { resolution: 'CLOSED', resolvedAt: now, resolvedBy: actor },
      });
    for (const row of rows) {
      const started = row.status === 'ACCEPTED' && row.startsAt <= now;
      await tx.applicationViewing.update({
        where: { id: row.id },
        data: started
          ? { status: 'OUTCOME_PENDING' }
          : { status: 'CANCELLED', cancelledAt: now },
      });
      if (!started && row.status === 'ACCEPTED')
        await tx.viewingAppointment.updateMany({
          where: { viewingId: row.id },
          data: {
            cancelledBy: actor,
            cancellationReason: 'APPLICATION_ENDED',
            lateCancellation:
              now.getTime() >= row.startsAt.getTime() - 6 * 60 * 60_000,
          },
        });
    }
    if (w?.mode === 'LEGACY')
      await tx.$executeRaw`
      UPDATE viewing_proposals target SET resolution=source.resolution, resolved_at=source.resolved_at, resolved_by=source.resolved_by
      FROM legacy_viewing_proposal_rows(${applicationId}::uuid) source
      WHERE target.id=source.id AND target.workflow_id=${w.id}::uuid`;
    await tx.viewingAppointment.updateMany({
      where: {
        workflow: { applicationId },
        interestState: {
          in: ['PENDING', 'LEGACY_UNANSWERED', 'NOT_REQUESTED'],
        },
      },
      data: { interestState: 'CLOSED', interestClosedAt: now },
    });
    if (w)
      await tx.viewingWorkflow.update({
        where: { id: w.id },
        data: {
          state: 'CLOSED',
          ...(options.consideration === 'DO_NOT_CONTINUE'
            ? {
                providerConsideration: 'DO_NOT_CONTINUE' as const,
                considerationDecidedAt: now,
              }
            : {}),
          ...(w.state === 'CLOSED'
            ? {}
            : { closedAt: now, closureReason: reason }),
          pendingProposalId: null,
          confirmedAppointmentId: null,
          revision: { increment: 1 },
          updatedAt: now,
        },
      });
    if (w || rows.length)
      await this.activity.appendWithinTransaction(tx, {
        applicationId,
        type: Event.VIEWING_WORKFLOW_CLOSED,
        actorType: actor,
        actorUserId,
        visibility: ref.activeAt ? Visibility.BOTH : Visibility.APPLICANT,
        occurredAt: now,
        metadata: {
          workflowId: w?.id,
          workflowRevision: w ? w.revision + 1 : undefined,
          proposalId:
            w?.mode === 'CURRENT'
              ? (w.pendingProposalId ?? undefined)
              : rows.find((row) => row.status === 'PROPOSED')?.id,
          appointmentId: rows.find((row) => row.status === 'ACCEPTED')?.id,
          viewingClosureReason:
            w?.state === 'CLOSED' ? (w.closureReason ?? reason) : reason,
          viewingLifecycleContext: options.context,
        },
      });
  }

  async closeListingWithinTransaction(
    tx: Prisma.TransactionClient,
    listingId: string,
    reason: ViewingClosureReason,
    actorUserId: string,
    selectedApplicationId?: string,
  ) {
    const apps = await tx.application.findMany({
      where: {
        listingId,
        // Preserve atomic closure while skipping historical/no-viewing rows.
        OR: [
          { viewingWorkflow: { state: 'OPEN' } },
          { viewings: { some: { status: { in: ['PROPOSED', 'ACCEPTED'] } } } },
          { viewingWorkflow: null, viewings: { some: {} } },
          {
            viewingWorkflow: {
              appointments: {
                some: {
                  interestState: { in: ['PENDING', 'LEGACY_UNANSWERED'] },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const app of apps)
      await this.closeWithinTransaction(
        tx,
        app.id,
        app.id === selectedApplicationId ? 'APPLICATION_ACCEPTED' : reason,
        Actor.PROVIDER,
        actorUserId,
      );
  }

  async restoreWithinTransaction(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
  ) {
    const before = await tx.viewingWorkflow.findUnique({
      where: { applicationId },
    });
    // Repair unanswered decision metadata from older closures without rewriting
    // the closure or its history. Restore is recorded by its lifecycle caller.
    await tx.viewingAppointment.updateMany({
      where: {
        workflow: { applicationId },
        interestState: {
          in: ['PENDING', 'LEGACY_UNANSWERED', 'NOT_REQUESTED'],
        },
      },
      data: { interestState: 'CLOSED', interestClosedAt: this.clock.now() },
    });
    const live = await tx.applicationViewing.count({
      where: { applicationId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
    });
    if (before?.state === 'CLOSED' && live === 0) {
      await tx.viewingWorkflow.update({
        where: { id: before.id },
        data: {
          providerConsideration: 'UNDECIDED',
          considerationDecidedAt: null,
          revision: { increment: 1 },
          updatedAt: this.clock.now(),
        },
      });
      return;
    }
    await this.closeWithinTransaction(
      tx,
      applicationId,
      'APPLICATION_REJECTED',
      Actor.PROVIDER,
      actorUserId,
      { context: 'RESTORE_CLEANUP' },
    );
    const w = await tx.viewingWorkflow.findUnique({ where: { applicationId } });
    if (w?.providerConsideration === 'DO_NOT_CONTINUE')
      await tx.viewingWorkflow.update({
        where: { id: w.id },
        data: {
          providerConsideration: 'UNDECIDED',
          considerationDecidedAt: null,
          revision: { increment: 1 },
        },
      });
  }
}
