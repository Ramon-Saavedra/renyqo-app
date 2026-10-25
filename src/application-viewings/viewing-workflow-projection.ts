import type {
  ViewingWorkflow,
  ViewingProposal,
  ViewingAppointment,
  ApplicationViewing,
  ApplicationViewingOutcome,
  ApplicationViewingInterest,
} from '../generated/prisma/client';
import {
  ApplicationViewingPolicy,
  CORRECTION_WINDOW_MS,
  legacyViewingAllowsActions,
  legacyInterestClosedByLifecycle,
} from './application-viewing.policy';
import { VIEWING_CHANGE_CUTOFF_MS } from './viewing-workflow-command.policy';
import type { ViewingAudience } from './application-viewing-access.service';

export type ProjectionAppointment = ApplicationViewing & {
  outcomes: ApplicationViewingOutcome[];
  interest: ApplicationViewingInterest | null;
  appointment: ViewingAppointment | null;
};
export type ViewingProjectionSource = {
  applicationId: string;
  considerationAppointmentId: string | null;
  workflow: ViewingWorkflow | null;
  confirmedProposal?: ViewingProposal | null;
  pending: ViewingProposal | null;
  latestProposal: ViewingProposal | null;
  appointments: ProjectionAppointment[];
  latestAcceptedId: string | null;
};
export type ViewingObligationAction =
  | 'APPLICANT_RESPOND_TO_VIEWING'
  | 'PROVIDER_RESPOND_TO_CHANGE_REQUEST'
  | 'PROVIDER_RECORD_VIEWING_OUTCOME'
  | 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST'
  | 'PROVIDER_DECIDE_CONSIDERATION'
  | 'PROVIDER_CLOSE_UNANSWERED_VIEWING';

export function projectViewingProposal(
  proposal: ViewingProposal | null,
  asOf: Date,
) {
  return proposal
    ? {
        proposalId: proposal.id,
        round: proposal.round,
        proposerSide: proposal.proposerSide,
        responderSide: proposal.responderSide,
        startsAt: proposal.startsAt,
        endsAt: proposal.endsAt,
        timeZone: proposal.timeZone,
        message: proposal.message,
        predecessorProposalId: proposal.predecessorProposalId,
        baseAppointmentId: proposal.baseAppointmentId,
        timing: proposal.timing,
        shortNotice: proposal.timing === 'SHORT_NOTICE',
        responseDeadlineAt: proposal.responseDeadlineAt,
        acceptanceBlockedReason:
          proposal.resolution !== 'PENDING'
            ? 'PROPOSAL_NOT_PENDING'
            : proposal.timing === 'LEGACY'
              ? 'LEGACY_INVITATION_REQUIRES_REISSUE'
              : proposal.responseDeadlineAt &&
                  asOf >= proposal.responseDeadlineAt
                ? 'PROPOSAL_EXPIRED'
                : null,
        resolution: proposal.resolution,
        resolvedAt: proposal.resolvedAt,
        resolvedBy: proposal.resolvedBy,
        effectiveResolution:
          proposal.resolution === 'PENDING' &&
          ((proposal.responseDeadlineAt &&
            asOf >= proposal.responseDeadlineAt) ||
            asOf >= proposal.startsAt)
            ? 'EXPIRED'
            : proposal.resolution,
      }
    : null;
}

/** Pure, clock-explicit projection. Reads never resolve or mutate expired records. */
export function projectViewingWorkflow(
  applicationId: string,
  source: ViewingProjectionSource,
  mutable: boolean,
  audience: ViewingAudience,
  asOf: Date,
) {
  const w = source.workflow;
  const current = w?.mode === 'CURRENT';
  const legacy = w?.mode === 'LEGACY' || (!w && source.appointments.length > 0);
  const side = audience === 'provider' ? 'PROVIDER' : 'APPLICANT';
  const ordered = [...source.appointments].sort((a, b) => b.round - a.round);
  const completed = ordered.find((a) => a.status === 'COMPLETED');
  const interestMetadata = current ? completed?.appointment : null;
  const interestExpired =
    interestMetadata?.interestState === 'PENDING' &&
    !!interestMetadata.interestDeadlineAt &&
    asOf >= interestMetadata.interestDeadlineAt;
  const active = mutable && current && !interestExpired;
  const open = active && w.state === 'OPEN';
  const postViewingOpen =
    active && (w.state === 'OPEN' || w.closureReason === 'PROVIDER_CLOSED');
  const confirmed = current
    ? ordered.find((a) => a.id === w.confirmedAppointmentId)
    : undefined;
  const latest = ordered[0];
  const p = current ? source.pending : null;
  const expired =
    !!p &&
    ((p.responseDeadlineAt !== null && asOf >= p.responseDeadlineAt) ||
      asOf >= p.startsAt);
  const pendingLive = !!p && p.resolution === 'PENDING' && !expired;
  const changeCutoffAt =
    current && confirmed
      ? new Date(confirmed.startsAt.getTime() - VIEWING_CHANGE_CUTOFF_MS)
      : null;
  const appointment = (a: ProjectionAppointment | undefined) =>
    a
      ? {
          appointmentId: a.id,
          status: a.status,
          proposalId: current ? (a.appointment?.proposalId ?? null) : null,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          timeZone: a.timeZone,
          cancellation:
            a.status === 'CANCELLED'
              ? {
                  cancelledAt: a.cancelledAt,
                  by: current ? (a.appointment?.cancelledBy ?? null) : null,
                  reason: current
                    ? (a.appointment?.cancellationReason ?? null)
                    : null,
                  message: current
                    ? (a.appointment?.cancellationNote ?? null)
                    : null,
                  late: current
                    ? (a.appointment?.lateCancellation ?? null)
                    : null,
                }
              : null,
        }
      : null;
  const outcomeAppointment = ordered.find((a) => a.outcomes.length > 0);
  const effective = outcomeAppointment?.outcomes.at(-1);
  const interestAvailable =
    !!completed &&
    postViewingOpen &&
    (interestMetadata?.interestState === 'LEGACY_UNANSWERED' ||
      (interestMetadata?.interestState === 'PENDING' &&
        !!interestMetadata.interestDeadlineAt &&
        !interestExpired));
  const target = (
    action: string,
    proposalId: string | null = null,
    appointmentId: string | null = null,
  ) => ({
    applicationId,
    workflowId: w?.id ?? null,
    proposalId,
    appointmentId,
    section: 'VIEWING' as const,
    action,
  });
  const obligations: {
    action: ViewingObligationAction;
    responsibleSide: 'PROVIDER' | 'APPLICANT';
    deadlineAt: Date | null;
    target: ReturnType<typeof target>;
  }[] = [];
  if (open && pendingLive && p)
    obligations.push({
      action:
        p.responderSide === 'APPLICANT'
          ? 'APPLICANT_RESPOND_TO_VIEWING'
          : 'PROVIDER_RESPOND_TO_CHANGE_REQUEST',
      responsibleSide: p.responderSide,
      deadlineAt: p.responseDeadlineAt,
      target: target('RESPOND_TO_PROPOSAL', p.id, p.baseAppointmentId),
    });
  // Terminal lifecycle closures still permit attendance resolution for a visit already started.
  const attendance = ordered.find(
    (a) =>
      ['ACCEPTED', 'OUTCOME_PENDING'].includes(a.status) &&
      !a.outcomes.length &&
      asOf >= a.endsAt &&
      (a.id === w?.confirmedAppointmentId || a.status === 'OUTCOME_PENDING'),
  );
  if (current && attendance)
    obligations.push({
      action: 'PROVIDER_RECORD_VIEWING_OUTCOME',
      responsibleSide: 'PROVIDER',
      deadlineAt: null,
      target: target('RECORD_ATTENDANCE', null, attendance.id),
    });
  if (interestAvailable && completed)
    obligations.push({
      action: 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
      responsibleSide: 'APPLICANT',
      deadlineAt: interestMetadata?.interestDeadlineAt ?? null,
      target: target('POST_VIEWING_INTEREST', null, completed.id),
    });
  const considerationCurrent =
    !!completed &&
    !!w?.considerationDecidedAt &&
    source.considerationAppointmentId === completed.id;
  const decisionEligible =
    !!completed &&
    postViewingOpen &&
    interestMetadata?.interestState !== 'CLOSED';
  if (decisionEligible && !considerationCurrent)
    obligations.push({
      action: 'PROVIDER_DECIDE_CONSIDERATION',
      responsibleSide: 'PROVIDER',
      deadlineAt: null,
      target: target('PROVIDER_CONSIDERATION', null, completed.id),
    });
  // Reuse the legacy policy against the live ledger, never the imported pointers.
  const legacyPolicy = new ApplicationViewingPolicy();
  const legacyMutable = (a: ProjectionAppointment) =>
    legacyViewingAllowsActions(
      mutable,
      w?.state === 'CLOSED',
      a.status,
      legacyInterestClosedByLifecycle(w, a),
    );
  if (legacy)
    for (const a of ordered) {
      const action = legacyPolicy.nextAction(
        a,
        legacyMutable(a),
        a.id === latest?.id,
        asOf,
      );
      if (action === 'NONE') continue;
      obligations.push({
        action,
        responsibleSide: action.startsWith('APPLICANT_')
          ? 'APPLICANT'
          : 'PROVIDER',
        deadlineAt: null,
        target: target(action, null, a.id),
      });
    }
  const baseBlocked = !mutable
    ? 'APPLICATION_PROCESS_INACTIVE'
    : interestExpired
      ? 'INTEREST_RESPONSE_EXPIRED'
      : legacy
        ? 'LEGACY_RECONCILIATION_REQUIRED'
        : null;
  const action = (
    name: string,
    reason: string | null,
    proposalId: string | null = null,
    appointmentId: string | null = null,
  ) => ({
    action: name,
    allowed: reason === null,
    blockedReason: reason,
    target: target(name, proposalId, appointmentId),
  });
  const proposalBlock =
    baseBlocked ??
    (!open
      ? 'WORKFLOW_NOT_OPEN'
      : !p
        ? 'NO_PENDING_PROPOSAL'
        : !pendingLive
          ? 'PROPOSAL_EXPIRED'
          : p.responderSide !== side
            ? 'ONLY_RESPONDER_CAN_DECIDE'
            : null);
  const futureBlock =
    baseBlocked ??
    (!confirmed
      ? 'NO_CONFIRMED_APPOINTMENT'
      : asOf >= confirmed.startsAt
        ? 'APPOINTMENT_ALREADY_STARTED'
        : null);
  const first = outcomeAppointment?.outcomes[0];
  const correctionCutoffAt = first
    ? new Date(first.recordedAt.getTime() + CORRECTION_WINDOW_MS)
    : null;
  const correctionBlock = legacy
    ? 'LEGACY_RECONCILIATION_REQUIRED'
    : audience !== 'provider'
      ? 'ACTION_NOT_ALLOWED_FOR_SIDE'
      : !outcomeAppointment ||
          outcomeAppointment.id !== source.latestAcceptedId ||
          outcomeAppointment.outcomes.length !== 1 ||
          outcomeAppointment.interest
        ? 'OUTCOME_CORRECTION_UNAVAILABLE'
        : correctionCutoffAt && asOf >= correctionCutoffAt
          ? 'OUTCOME_CORRECTION_WINDOW_CLOSED'
          : null;
  const capabilities = [
    action(
      'INVITE',
      baseBlocked ??
        (audience !== 'provider'
          ? 'PROVIDER_INVITATION_REQUIRED'
          : p || confirmed
            ? 'VIEWING_ALREADY_PENDING_OR_CONFIRMED'
            : null),
    ),
    action(
      'ACCEPT_PROPOSAL',
      proposalBlock ??
        (p?.timing === 'LEGACY' || !p?.responseDeadlineAt
          ? 'LEGACY_INVITATION_REQUIRES_REISSUE'
          : confirmed && asOf >= confirmed.startsAt
            ? 'APPOINTMENT_ALREADY_STARTED'
            : null),
      p?.id,
    ),
    action('REJECT_PROPOSAL', proposalBlock, p?.id),
    action(
      'COUNTERPROPOSE',
      baseBlocked ??
        (!open || !p
          ? 'NO_PENDING_PROPOSAL'
          : !pendingLive
            ? 'PROPOSAL_EXPIRED'
            : confirmed && asOf >= confirmed.startsAt
              ? 'APPOINTMENT_ALREADY_STARTED'
              : audience === 'applicant' && p.proposerSide !== 'PROVIDER'
                ? 'PROVIDER_INVITATION_REQUIRED'
                : audience === 'applicant' &&
                    changeCutoffAt &&
                    asOf >= changeCutoffAt
                  ? 'APPLICANT_CHANGE_CUTOFF_PASSED'
                  : null),
      p?.id,
      confirmed?.id,
    ),
    action(
      'PROPOSE_REPLACEMENT',
      futureBlock ??
        (p
          ? 'PENDING_PROPOSAL_MUST_BE_RESOLVED'
          : audience === 'applicant' && changeCutoffAt && asOf >= changeCutoffAt
            ? 'APPLICANT_CHANGE_CUTOFF_PASSED'
            : null),
      null,
      confirmed?.id,
    ),
    action(
      'WITHDRAW_ALTERNATIVE',
      baseBlocked ??
        (!open || !p
          ? 'NO_PENDING_PROPOSAL'
          : !pendingLive
            ? 'PROPOSAL_EXPIRED'
            : audience !== 'applicant' || p.proposerSide !== 'APPLICANT'
              ? 'ONLY_OWN_ALTERNATIVE_CAN_BE_WITHDRAWN'
              : null),
      p?.id,
    ),
    action(
      'CANCEL_APPOINTMENT',
      futureBlock ??
        (audience !== 'applicant' ? 'ACTION_NOT_ALLOWED_FOR_SIDE' : null),
      null,
      confirmed?.id,
    ),
    action(
      'CLOSE_FLOW',
      baseBlocked ??
        (audience !== 'provider'
          ? 'ACTION_NOT_ALLOWED_FOR_SIDE'
          : confirmed && asOf >= confirmed.startsAt
            ? 'APPOINTMENT_ALREADY_STARTED'
            : !p && !confirmed
              ? 'NO_OPEN_VIEWING'
              : null),
      p?.id,
      confirmed?.id,
    ),
    action(
      'RECORD_OUTCOME',
      !current
        ? 'LEGACY_RECONCILIATION_REQUIRED'
        : audience !== 'provider'
          ? 'ACTION_NOT_ALLOWED_FOR_SIDE'
          : !attendance
            ? 'NO_ATTENDANCE_TO_RECORD'
            : null,
      null,
      attendance?.id,
    ),
    action('CORRECT_OUTCOME', correctionBlock, null, outcomeAppointment?.id),
    action(
      'SUBMIT_INTEREST',
      baseBlocked ??
        (audience !== 'applicant'
          ? 'ACTION_NOT_ALLOWED_FOR_SIDE'
          : interestExpired
            ? 'INTEREST_RESPONSE_EXPIRED'
            : !interestAvailable
              ? 'INTEREST_RESPONSE_UNAVAILABLE'
              : null),
      null,
      completed?.id,
    ),
    action(
      'SET_CONSIDERATION',
      baseBlocked ??
        (audience !== 'provider'
          ? 'ACTION_NOT_ALLOWED_FOR_SIDE'
          : !completed
            ? 'CONSIDERATION_REQUIRES_COMPLETED_VIEWING'
            : !decisionEligible
              ? 'POST_VIEWING_DECISION_CLOSED'
              : null),
      null,
      completed?.id,
    ),
  ];
  const boundaries: Date[] = [];
  if (current) {
    if (active && pendingLive && p)
      boundaries.push(
        ...[p.responseDeadlineAt, p.startsAt].filter((v): v is Date => !!v),
      );
    if (confirmed)
      boundaries.push(
        confirmed.startsAt,
        confirmed.endsAt,
        ...(changeCutoffAt ? [changeCutoffAt] : []),
      );
    for (const a of ordered)
      if (a.status === 'OUTCOME_PENDING') boundaries.push(a.endsAt);
    if (
      interestMetadata?.interestState === 'PENDING' &&
      interestMetadata.interestDeadlineAt
    )
      boundaries.push(interestMetadata.interestDeadlineAt);
    if (
      audience === 'provider' &&
      correctionCutoffAt &&
      outcomeAppointment?.outcomes.length === 1 &&
      !outcomeAppointment.interest
    )
      boundaries.push(correctionCutoffAt);
  }
  if (legacy)
    for (const a of ordered) {
      const boundary = legacyPolicy.attentionRevalidatesAt(
        a,
        legacyMutable(a),
        a.id === latest?.id,
        asOf,
      );
      if (boundary) boundaries.push(boundary);
    }
  const nextRevalidateAt =
    boundaries
      .filter((b) => b > asOf)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return {
    applicationId,
    workflowId: w?.id ?? null,
    workflowRevision: w?.revision ?? 0,
    mode: legacy
      ? ('LEGACY' as const)
      : current
        ? ('CURRENT' as const)
        : ('EMPTY' as const),
    reconciliationRequired: legacy,
    asOf,
    confirmedAppointment: confirmed
      ? {
          ...appointment(confirmed)!,
          timing: source.confirmedProposal?.timing ?? null,
          shortNotice:
            source.confirmedProposal &&
            source.confirmedProposal.timing !== 'LEGACY'
              ? source.confirmedProposal.timing === 'SHORT_NOTICE'
              : null,
        }
      : null,
    pendingProposal: projectViewingProposal(p, asOf),
    latestProposal: current
      ? projectViewingProposal(source.latestProposal, asOf)
      : null,
    latestAppointment: appointment(latest),
    changeCutoffAt,
    outcome:
      effective && outcomeAppointment
        ? {
            appointmentId: outcomeAppointment.id,
            startsAt: outcomeAppointment.startsAt,
            endsAt: outcomeAppointment.endsAt,
            timeZone: outcomeAppointment.timeZone,
            outcome: effective.outcome,
            absenceSide: effective.absenceSide,
            revision: effective.revision,
            recordedAt: effective.recordedAt,
            correctionCutoffAt,
          }
        : null,
    applicantInterest: completed
      ? {
          appointmentId: completed.id,
          state: interestExpired
            ? 'EXPIRED'
            : (interestMetadata?.interestState ??
              completed.interest?.interest ??
              ((
                legacy
                  ? legacyInterestClosedByLifecycle(w, completed)
                  : w?.state === 'CLOSED'
              )
                ? 'CLOSED'
                : 'LEGACY_UNANSWERED')),
          storedState: interestMetadata?.interestState ?? null,
          deadlineAt: interestMetadata?.interestDeadlineAt ?? null,
          respondedAt: completed.interest?.respondedAt ?? null,
          lifecycleExpiryPending: !!interestExpired && mutable,
        }
      : null,
    providerConsideration: current
      ? {
          state: w.providerConsideration,
          decidedAt: w.considerationDecidedAt,
          appointmentId: considerationCurrent ? (completed?.id ?? null) : null,
          decisionRequired: decisionEligible && !considerationCurrent,
        }
      : null,
    closure:
      w && (current || w.state === 'CLOSED')
        ? { state: w.state, reason: w.closureReason, closedAt: w.closedAt }
        : null,
    obligations,
    nextObligation: obligations[0] ?? null,
    capabilities,
    nextRevalidateAt,
  };
}

export type ViewingWorkflowProjection = ReturnType<
  typeof projectViewingWorkflow
>;
