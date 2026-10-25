import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ViewingClock } from './application-viewing.policy';

export type ViewingExpiryTarget = {
  applicationId: string;
  id: string;
  kind: 'proposal' | 'interest';
};

@Injectable()
export class ViewingWorkflowExpiryService {
  private readonly logger = new Logger(ViewingWorkflowExpiryService.name);
  private sweepBefore: Date | null = null;
  private after: {
    deadline: Date;
    id: string;
    kind: 'proposal' | 'interest';
  } | null = null;
  private scanTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ViewingClock,
    private readonly activity: ApplicationActivityService,
    private readonly lifecycle: ApplicationLifecycleService,
  ) {}

  /** Caller holds listing then application locks in a Serializable transaction. */
  async proposalWithinTransaction(
    tx: Prisma.TransactionClient,
    applicationId: string,
    proposalId: string,
    now: Date,
  ): Promise<boolean> {
    const w = await tx.viewingWorkflow.findUnique({
      where: { applicationId },
      include: { pendingProposal: true },
    });
    const p = w?.pendingProposal;
    if (
      !w ||
      w.mode !== 'CURRENT' ||
      w.state !== 'OPEN' ||
      !p ||
      p.id !== proposalId ||
      p.resolution !== 'PENDING' ||
      p.timing === 'LEGACY' ||
      !p.responseDeadlineAt ||
      (now < p.responseDeadlineAt && now < p.startsAt)
    )
      return false;
    await tx.viewingProposal.update({
      where: { id: p.id },
      data: { resolution: 'EXPIRED', resolvedAt: now, resolvedBy: 'SYSTEM' },
    });
    await tx.viewingWorkflow.update({
      where: { id: w.id },
      data: {
        pendingProposalId: null,
        revision: { increment: 1 },
        updatedAt: now,
      },
    });
    await this.activity.appendWithinTransaction(tx, {
      applicationId,
      type: 'VIEWING_PROPOSAL_EXPIRED',
      actorType: 'SYSTEM',
      visibility: 'BOTH',
      occurredAt: now,
      metadata: {
        workflowId: w.id,
        workflowRevision: w.revision + 1,
        proposalId: p.id,
        viewingRound: p.round,
      },
    });
    return true;
  }

  /** Exact appointment identity is rechecked by the lifecycle operation under locks. */
  async interestWithinTransaction(
    tx: Prisma.TransactionClient,
    applicationId: string,
    now: Date,
  ): Promise<boolean> {
    const w = await tx.viewingWorkflow.findUnique({ where: { applicationId } });
    if (
      !w ||
      w.mode !== 'CURRENT' ||
      (w.state !== 'OPEN' && w.closureReason !== 'PROVIDER_CLOSED')
    )
      return false;
    const completed = await tx.applicationViewing.findFirst({
      where: { applicationId, status: 'COMPLETED' },
      orderBy: { round: 'desc' },
      select: { id: true },
    });
    if (!completed) return false;
    return this.lifecycle.expireViewingInterestWithinTransaction(
      tx,
      applicationId,
      completed.id,
      w.revision,
      now,
    );
  }

  async processTarget(target: ViewingExpiryTarget): Promise<boolean> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      const ref = await tx.application.findUnique({
        where: { id: target.applicationId },
        select: { listingId: true },
      });
      if (!ref) return false;
      // Never claim/lock a proposal before the established domain lock order.
      await tx.$queryRaw`SELECT id FROM listings WHERE id=${ref.listingId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM applications WHERE id=${target.applicationId}::uuid FOR UPDATE`;
      const now = this.clock.now();
      if (target.kind === 'proposal')
        return this.proposalWithinTransaction(
          tx,
          target.applicationId,
          target.id,
          now,
        );
      const w = await tx.viewingWorkflow.findUnique({
        where: { applicationId: target.applicationId },
      });
      if (!w) return false;
      return this.lifecycle.expireViewingInterestWithinTransaction(
        tx,
        target.applicationId,
        target.id,
        w.revision,
        now,
      );
    });
  }

  runOnce(batchSize = 50) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
      return Promise.reject(
        new Error('Viewing expiry batch size must be between 1 and 500'),
      );
    // The scheduler already avoids overlap. Also protect manual/concurrent calls
    // on this instance from racing its scan cursor; domain locks protect instances.
    const run = this.scanTail.then(() => this.processBatch(batchSize));
    this.scanTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async candidates(batchSize: number) {
    this.sweepBefore ??= this.clock.now();
    const now = this.sweepBefore;
    const after = this.after;
    const [proposals, interests] = await Promise.all([
      this.prisma.viewingProposal.findMany({
        where: {
          resolution: 'PENDING',
          timing: { not: 'LEGACY' },
          responseDeadlineAt: { lte: now },
          pendingFor: { mode: 'CURRENT', state: 'OPEN' },
          ...(after
            ? {
                OR: [
                  { responseDeadlineAt: { gt: after.deadline } },
                  {
                    responseDeadlineAt: after.deadline,
                    id:
                      after.kind === 'interest'
                        ? { gte: after.id }
                        : { gt: after.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ responseDeadlineAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        select: {
          id: true,
          responseDeadlineAt: true,
          workflow: { select: { applicationId: true } },
        },
      }),
      this.prisma.viewingAppointment.findMany({
        where: {
          interestState: 'PENDING',
          interestDeadlineAt: { lte: now },
          workflow: {
            mode: 'CURRENT',
            OR: [
              { state: 'OPEN' },
              { state: 'CLOSED', closureReason: 'PROVIDER_CLOSED' },
            ],
            application: {
              status: 'ACTIVE',
              listing: { status: { in: ['PUBLISHED', 'PAUSED'] } },
            },
          },
          ...(after
            ? {
                OR: [
                  { interestDeadlineAt: { gt: after.deadline } },
                  {
                    interestDeadlineAt: after.deadline,
                    viewingId: { gt: after.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ interestDeadlineAt: 'asc' }, { viewingId: 'asc' }],
        take: batchSize,
        select: {
          viewingId: true,
          interestDeadlineAt: true,
          workflow: { select: { applicationId: true } },
        },
      }),
    ]);
    return [
      ...proposals.map((p) => ({
        applicationId: p.workflow.applicationId,
        id: p.id,
        kind: 'proposal' as const,
        deadline: p.responseDeadlineAt!,
      })),
      ...interests.map((a) => ({
        applicationId: a.workflow.applicationId,
        id: a.viewingId,
        kind: 'interest' as const,
        deadline: a.interestDeadlineAt!,
      })),
    ]
      .sort(
        (a, b) =>
          a.deadline.getTime() - b.deadline.getTime() ||
          a.id.localeCompare(b.id) ||
          a.kind.localeCompare(b.kind),
      )
      .slice(0, batchSize);
  }

  private async processBatch(batchSize: number) {
    let targets = await this.candidates(batchSize);
    if (!targets.length && this.after) {
      this.after = null;
      this.sweepBefore = null;
      targets = await this.candidates(batchSize);
    }
    let processed = 0,
      failed = 0;
    for (const target of targets) {
      try {
        if (await this.processTarget(target)) processed++;
      } catch {
        failed++;
        // No private payloads or database/session errors in operational logs.
        this.logger.error({
          signal: 'VIEWING_EXPIRY_FAILED',
          applicationId: target.applicationId,
          kind: target.kind,
          targetId: target.id,
        });
      }
    }
    // Even failed and stale/no-op targets advance the scan. The fixed cutoff
    // prevents new deadlines from stretching a sweep forever. On wrap all due
    // rows, including poisoned ones, remain discoverable in the database.
    this.after = targets.at(-1) ?? null;
    if (targets.length < batchSize) {
      this.after = null;
      this.sweepBefore = null;
    }
    return { scanned: targets.length, processed, failed };
  }
}
