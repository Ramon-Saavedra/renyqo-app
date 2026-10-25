import { Injectable } from '@nestjs/common';
import { ApplicationViewingStatus } from '../generated/prisma/enums';
import { Prisma } from '../generated/prisma/client';
import {
  ApplicationViewingPolicy,
  legacyViewingAllowsActions,
} from './application-viewing.policy';
import type { ViewingAudience } from './application-viewing-access.service';
import {
  projectViewingWorkflow,
  type ViewingProjectionSource,
  type ProjectionAppointment,
} from './viewing-workflow-projection';

type LegacySummaryRow = Pick<
  ProjectionAppointment,
  | 'id'
  | 'applicationId'
  | 'round'
  | 'status'
  | 'startsAt'
  | 'endsAt'
  | 'timeZone'
  | 'createdAt'
  | 'changeRequestedAt'
> & {
  interest: Pick<
    NonNullable<ProjectionAppointment['interest']>,
    'id' | 'interest' | 'respondedAt'
  > | null;
  outcomes: Pick<
    ProjectionAppointment['outcomes'][number],
    'recordedAt' | 'revision' | 'outcome'
  >[];
};

@Injectable()
export class ApplicationViewingReadService {
  constructor(readonly policy: ApplicationViewingPolicy) {}

  summary(
    rows: LegacySummaryRow[],
    mutable: boolean,
    latestRound: number | null | undefined,
    asOf: Date,
    audience: ViewingAudience,
    source?: ViewingProjectionSource,
  ) {
    const projection = source
      ? projectViewingWorkflow(
          source.applicationId,
          source,
          mutable,
          audience,
          asOf,
        )
      : null;
    const legacyMutable = (row: LegacySummaryRow) =>
      projection?.mode !== 'CURRENT' &&
      legacyViewingAllowsActions(
        mutable,
        source?.workflow?.state === 'CLOSED',
        row.status,
      );
    const ordered = [...rows].sort((a, b) => b.round - a.round);
    const latest = ordered.find((row) => row.round === latestRound);
    const current = ordered.find(
      (row) =>
        this.policy.unresolved(row) ||
        row.status === ApplicationViewingStatus.OUTCOME_PENDING,
    );
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
              legacyMutable(row),
              row.round === latestRound,
              asOf,
            ),
            capabilities: this.policy.capabilities(
              row,
              audience,
              legacyMutable(row),
              row.round === latestRound,
              asOf,
            ),
          }
        : null;
    const currentDto = dto(current);
    const latestDto = dto(latest);
    const pendingDto = dto(pending);
    return {
      ...(projection ?? {}),
      nextObligation: projection?.nextObligation ?? null,
      current: currentDto,
      latest: latestDto,
      latestCompleted: dto(completed),
      pendingInterest: pendingDto,
      changeRequested:
        latest?.status === ApplicationViewingStatus.CHANGE_REQUESTED
          ? latestDto
          : null,
      canPropose:
        projection?.mode === 'CURRENT'
          ? !!projection.capabilities.find((c) => c.action === 'INVITE')
              ?.allowed
          : audience === 'provider' && mutable && !current,
      nextAction:
        projection?.mode === 'CURRENT'
          ? (projection.nextObligation?.action ?? 'NONE')
          : currentDto && currentDto.nextAction !== 'NONE'
            ? currentDto.nextAction
            : latest?.status === ApplicationViewingStatus.CHANGE_REQUESTED
              ? (latestDto?.nextAction ?? 'NONE')
              : (pendingDto?.nextAction ?? 'NONE'),
    };
  }

  async batch(tx: Prisma.TransactionClient, applicationIds: readonly string[]) {
    if (!applicationIds.length)
      return {
        rows: [],
        rounds: new Map<string, number | null>(),
        workflows: new Map<string, ViewingProjectionSource>(),
      };
    const workflows = await tx.viewingWorkflow.findMany({
      where: { applicationId: { in: [...applicationIds] } },
    });
    const workflowIds = workflows
      .filter((w) => w.mode === 'CURRENT')
      .map((w) => w.id);
    const decisions = workflowIds.length
      ? await tx.$queryRaw<
          { applicationId: string; appointmentId: string | null }[]
        >(Prisma.sql`
      SELECT DISTINCT ON (application_id) application_id AS "applicationId", payload->>'appointmentId' AS "appointmentId"
      FROM application_activities
      WHERE application_id IN (${Prisma.join(applicationIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND type = 'viewing_consideration_changed'
        AND payload->>'workflowId' IN (${Prisma.join(workflowIds)})
      ORDER BY application_id, CASE WHEN jsonb_typeof(payload->'workflowRevision') = 'number' THEN (payload->>'workflowRevision')::numeric END DESC NULLS LAST, occurred_at DESC, id DESC
    `)
      : [];
    const proposalRounds = workflowIds.length
      ? await tx.viewingProposal.groupBy({
          by: ['workflowId'],
          where: { workflowId: { in: workflowIds } },
          _max: { round: true },
        })
      : [];
    const pendingIds = workflows
      .filter((w) => w.mode === 'CURRENT' && w.pendingProposalId)
      .map((w) => w.pendingProposalId!);
    const confirmedIds = workflows
      .filter((w) => w.mode === 'CURRENT' && w.confirmedAppointmentId)
      .map((w) => w.confirmedAppointmentId!);
    const proposals = workflowIds.length
      ? await tx.viewingProposal.findMany({
          where: {
            workflowId: { in: workflowIds },
            OR: [
              { id: { in: [...pendingIds, ...confirmedIds] } },
              ...proposalRounds.map((p) => ({
                workflowId: p.workflowId,
                round: p._max.round ?? 0,
              })),
            ],
          },
        })
      : [];
    const pending = proposals.filter((p) => pendingIds.includes(p.id));
    const latestAccepted = await tx.applicationViewing.groupBy({
      by: ['applicationId'],
      where: {
        applicationId: { in: [...applicationIds] },
        acceptedAt: { not: null },
      },
      _max: { round: true },
    });
    const latest = await tx.applicationViewing.groupBy({
      by: ['applicationId'],
      where: { applicationId: { in: [...applicationIds] } },
      _max: { round: true },
    });
    const rounds = new Map(
      latest.map((row) => [row.applicationId, row._max.round]),
    );
    const completed = await tx.applicationViewing.groupBy({
      by: ['applicationId', 'status'],
      where: {
        applicationId: { in: [...applicationIds] },
        status: {
          in: [
            ApplicationViewingStatus.COMPLETED,
            ApplicationViewingStatus.NO_SHOW,
          ],
        },
      },
      _max: { round: true },
    });
    const ledger = await tx.applicationViewing.findMany({
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
          ...latestAccepted.map((row) => ({
            applicationId: row.applicationId,
            round: row._max.round ?? 0,
          })),
          {
            status: {
              in: [
                ApplicationViewingStatus.PROPOSED,
                ApplicationViewingStatus.ACCEPTED,
                ApplicationViewingStatus.OUTCOME_PENDING,
              ],
            },
          },
          { status: ApplicationViewingStatus.COMPLETED, interest: null },
        ],
      },
    });
    const viewingIds = ledger.map((row) => row.id);
    // Explicit sequential scalar reads avoid Prisma executing sibling relation queries
    // concurrently on the same PostgreSQL transaction connection.
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
    const rows = ledger.map((row) => ({
      ...row,
      outcomes: outcomes.filter((o) => o.viewingId === row.id),
      interest: interests.find((i) => i.viewingId === row.id) ?? null,
      appointment: metadata.find((a) => a.viewingId === row.id) ?? null,
    }));
    const sources = new Map<string, ViewingProjectionSource>();
    for (const applicationId of applicationIds) {
      const workflow =
        workflows.find((w) => w.applicationId === applicationId) ?? null;
      const appointments = rows.filter(
        (row) => row.applicationId === applicationId,
      );
      const acceptedRound = latestAccepted.find(
        (row) => row.applicationId === applicationId,
      )?._max.round;
      sources.set(applicationId, {
        applicationId,
        considerationAppointmentId:
          decisions.find((d) => d.applicationId === applicationId)
            ?.appointmentId ?? null,
        workflow,
        confirmedProposal:
          proposals.find(
            (p) =>
              p.id ===
              appointments.find(
                (a) => a.id === workflow?.confirmedAppointmentId,
              )?.appointment?.proposalId,
          ) ?? null,
        pending:
          pending.find((p) => p.id === workflow?.pendingProposalId) ?? null,
        latestProposal:
          proposals
            .filter((p) => p.workflowId === workflow?.id)
            .sort((a, b) => b.round - a.round)[0] ?? null,
        appointments,
        latestAcceptedId:
          appointments.find((a) => a.round === acceptedRound)?.id ?? null,
      });
    }
    return { rows, rounds, workflows: sources };
  }

  facts(
    rows: LegacySummaryRow[],
    mutable: boolean,
    latestRound: number | null | undefined,
    asOf: Date,
    source?: ViewingProjectionSource,
    audience: ViewingAudience = 'provider',
  ) {
    if (source) {
      const projection = projectViewingWorkflow(
        source.applicationId,
        source,
        mutable,
        audience,
        asOf,
      );
      return [
        ...projection.obligations.map((item) => ({
          viewingId:
            item.target.appointmentId ??
            item.target.proposalId ??
            source.workflow?.id ??
            source.applicationId,
          nextAction: item.action,
          pendingSince: (() => {
            const row = source.appointments.find(
              (a) => a.id === item.target.appointmentId,
            );
            if (item.target.proposalId)
              return source.pending?.createdAt ?? asOf;
            if (!row) return asOf;
            if (item.action === 'PROVIDER_RECORD_VIEWING_OUTCOME')
              return row.endsAt;
            if (item.action === 'PROVIDER_CLOSE_UNANSWERED_VIEWING')
              return row.startsAt;
            if (item.action === 'PROVIDER_RESPOND_TO_CHANGE_REQUEST')
              return row.changeRequestedAt ?? row.createdAt;
            return (
              row.appointment?.interestRequestedAt ??
              row.outcomes.at(-1)?.recordedAt ??
              row.createdAt
            );
          })(),
          revalidatesAt: projection.nextRevalidateAt,
          workflowTarget: item.target,
        })),
        {
          viewingId: source.workflow?.id ?? source.applicationId,
          nextAction: 'NONE' as const,
          pendingSince: asOf,
          revalidatesAt: projection.nextRevalidateAt,
        },
      ];
    }
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
      return {
        viewingId: row.id,
        nextAction,
        pendingSince,
        revalidatesAt: this.policy.attentionRevalidatesAt(
          row,
          mutable,
          row.round === latestRound,
          asOf,
        ),
      };
    });
  }
}
