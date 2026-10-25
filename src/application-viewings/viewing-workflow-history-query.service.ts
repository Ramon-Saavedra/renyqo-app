import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplicationViewingAccessService,
  type ViewingAudience,
} from './application-viewing-access.service';
import { ViewingClock } from './application-viewing.policy';
import { ViewingQueryDto } from './dto/viewing-input.dto';
import { projectViewingProposal } from './viewing-workflow-projection';

@Injectable()
export class ViewingWorkflowHistoryQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationViewingAccessService,
    private readonly clock: ViewingClock,
  ) {}

  proposals(
    applicationId: string,
    userId: string,
    side: ViewingAudience,
    query: ViewingQueryDto,
    proposalId?: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorize(tx, applicationId, userId, side);
        const asOf = this.clock.now();
        const workflow = await tx.viewingWorkflow.findUnique({
          where: { applicationId },
        });
        const legacy =
          workflow?.mode === 'LEGACY' ||
          (!workflow &&
            (await tx.applicationViewing.count({ where: { applicationId } })) >
              0);
        // Imported proposal snapshots are not a live legacy history source.
        const rows =
          workflow?.mode === 'CURRENT'
            ? await tx.viewingProposal.findMany({
                where: {
                  workflowId: workflow.id,
                  ...(proposalId ? { id: proposalId } : {}),
                  ...(query.beforeRound
                    ? { round: { lt: query.beforeRound } }
                    : {}),
                },
                orderBy: { round: 'desc' },
                take: proposalId ? 1 : query.limit + 1,
              })
            : [];
        if (proposalId && !rows.length)
          throw new NotFoundException('Viewing proposal not found');
        const ids = rows.slice(0, query.limit).map((p) => p.id);
        const ledger = ids.length
          ? await tx.applicationViewing.findMany({
              where: { applicationId, id: { in: ids } },
            })
          : [];
        const viewingIds = ledger.map((v) => v.id);
        const outcomes = viewingIds.length
          ? await tx.applicationViewingOutcome.findMany({
              where: { viewingId: { in: viewingIds } },
              orderBy: { revision: 'asc' },
            })
          : [];
        const interests = viewingIds.length
          ? await tx.applicationViewingInterest.findMany({
              where: { viewingId: { in: viewingIds } },
            })
          : [];
        const metadata = viewingIds.length
          ? await tx.viewingAppointment.findMany({
              where: { viewingId: { in: viewingIds } },
            })
          : [];
        const items = rows.slice(0, query.limit).map((p) => ({
          ...projectViewingProposal(p, asOf)!,
          appointment: (() => {
            const v = ledger.find((v) => v.id === p.id);
            if (!v) return null;
            const a = metadata.find((a) => a.viewingId === v.id);
            const interest = interests.find((i) => i.viewingId === v.id);
            return {
              appointmentId: v.id,
              status: v.status,
              startsAt: v.startsAt,
              endsAt: v.endsAt,
              timeZone: v.timeZone,
              acceptedAt: v.acceptedAt,
              cancelledAt: v.cancelledAt,
              supersededAt: v.supersededAt,
              cancellation:
                v.status === 'CANCELLED'
                  ? {
                      by: a?.cancelledBy ?? null,
                      reason: a?.cancellationReason ?? null,
                      message: a?.cancellationNote ?? null,
                      late: a?.lateCancellation ?? null,
                    }
                  : null,
              outcomes: outcomes
                .filter((o) => o.viewingId === v.id)
                .map((o) => ({
                  revision: o.revision,
                  outcome: o.outcome,
                  absenceSide: o.absenceSide,
                  correctionReason: o.correctionReason,
                  recordedAt: o.recordedAt,
                })),
              applicantInterest: a
                ? {
                    storedState: a.interestState,
                    state:
                      a.interestState === 'PENDING' &&
                      a.interestDeadlineAt &&
                      asOf >= a.interestDeadlineAt
                        ? 'EXPIRED'
                        : a.interestState,
                    deadlineAt: a.interestDeadlineAt,
                    respondedAt: interest?.respondedAt ?? null,
                    interest: interest?.interest ?? null,
                  }
                : null,
            };
          })(),
          applicationId,
          workflowId: workflow!.id,
          target: {
            applicationId,
            workflowId: workflow!.id,
            proposalId: p.id,
            appointmentId:
              p.resolution === 'ACCEPTED' ? p.id : p.baseAppointmentId,
            section: 'VIEWING',
            action: 'VIEW_PROPOSAL',
          },
        }));
        return proposalId
          ? items[0]
          : {
              asOf,
              applicationId,
              workflowId: workflow?.id ?? null,
              reconciliationRequired: legacy,
              items,
              pagination: {
                limit: query.limit,
                hasMore: rows.length > query.limit,
                nextBeforeRound:
                  rows.length > query.limit
                    ? (items.at(-1)?.round ?? null)
                    : null,
              },
            };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
