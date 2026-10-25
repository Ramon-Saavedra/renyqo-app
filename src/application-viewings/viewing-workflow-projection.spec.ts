import {
  projectViewingWorkflow,
  type ViewingProjectionSource,
  type ProjectionAppointment,
} from './viewing-workflow-projection';
import type {
  ViewingWorkflow,
  ViewingProposal,
} from '../generated/prisma/client';
import { ApplicationViewingReadService } from './application-viewing-read.service';
import { ApplicationViewingPolicy } from './application-viewing.policy';
import { ApplicationPendingActionService } from '../application-attention/application-pending-action.service';
import { emptyConversationFacts } from '../application-conversation/application-conversation-read.service';

const now = new Date('2027-01-01T10:00:00Z');
const start = new Date('2027-01-03T10:00:00Z');
const end = new Date('2027-01-03T10:30:00Z');
function workflow(patch: Partial<ViewingWorkflow> = {}): ViewingWorkflow {
  return {
    id: 'workflow',
    applicationId: 'application',
    mode: 'CURRENT',
    revision: 3,
    initiatorSide: 'PROVIDER',
    state: 'OPEN',
    closureReason: null,
    closedAt: null,
    pendingProposalId: null,
    confirmedAppointmentId: 'appointment',
    providerConsideration: 'UNDECIDED',
    considerationDecidedAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
function appointment(
  patch: Partial<ProjectionAppointment> = {},
): ProjectionAppointment {
  return {
    id: 'appointment',
    applicationId: 'application',
    round: 1,
    status: 'ACCEPTED',
    startsAt: start,
    endsAt: end,
    timeZone: 'Europe/Berlin',
    providerNote: null,
    acceptedAt: now,
    declinedAt: null,
    changeRequestedAt: null,
    changeRequestMessage: null,
    cancelledAt: null,
    supersededAt: null,
    requestKey: 'key',
    requestHash: 'hash',
    createdAt: now,
    updatedAt: now,
    outcomes: [],
    interest: null,
    appointment: {
      viewingId: 'appointment',
      workflowId: 'workflow',
      proposalId: 'original',
      cancelledBy: null,
      cancellationReason: null,
      cancellationNote: null,
      lateCancellation: null,
      interestState: 'NOT_REQUESTED',
      interestRequestedAt: null,
      interestDeadlineAt: null,
      interestClosedAt: null,
    },
    ...patch,
  };
}
function proposal(patch: Partial<ViewingProposal> = {}): ViewingProposal {
  return {
    id: 'proposal',
    workflowId: 'workflow',
    round: 2,
    proposerSide: 'APPLICANT',
    responderSide: 'PROVIDER',
    startsAt: new Date('2027-01-04T10:00:00Z'),
    endsAt: new Date('2027-01-04T10:30:00Z'),
    timeZone: 'Europe/Berlin',
    message: 'Please meet later',
    predecessorProposalId: 'original',
    baseAppointmentId: 'appointment',
    timing: 'NORMAL',
    responseDeadlineAt: new Date('2027-01-01T22:00:00Z'),
    resolution: 'PENDING',
    resolvedAt: null,
    resolvedBy: null,
    requestKey: 'key2',
    requestHash: 'hash2',
    createdAt: now,
    ...patch,
  };
}
function source(
  patch: Partial<ViewingProjectionSource> = {},
): ViewingProjectionSource {
  return {
    applicationId: 'application',
    considerationAppointmentId: null,
    workflow: workflow(),
    pending: null,
    latestProposal: null,
    appointments: [appointment()],
    latestAcceptedId: 'appointment',
    ...patch,
  };
}
function project(
  s = source(),
  at = now,
  side: 'provider' | 'applicant' = 'provider',
  mutable = true,
) {
  return projectViewingWorkflow('application', s, mutable, side, at);
}
function capability(p: ReturnType<typeof project>, action: string) {
  return p.capabilities.find((c) => c.action === action);
}
function completed() {
  const a = appointment({
    status: 'COMPLETED',
    outcomes: [
      {
        id: 'outcome',
        viewingId: 'appointment',
        revision: 1,
        outcome: 'COMPLETED',
        absenceSide: null,
        correctionReason: null,
        recordedAt: end,
      },
    ],
  });
  a.appointment = {
    ...a.appointment!,
    interestState: 'PENDING',
    interestRequestedAt: end,
    interestDeadlineAt: new Date(end.getTime() + 48 * 3600000),
  };
  return source({
    workflow: workflow({ confirmedAppointmentId: null }),
    appointments: [a],
  });
}

describe('authoritative viewing projection', () => {
  it.each(['PENDING', 'LEGACY_UNANSWERED'] as const)(
    'blocks stale %s post-viewing metadata on a closed workflow after restore',
    (state) => {
      const s = completed();
      s.workflow = workflow({
        state: 'CLOSED',
        confirmedAppointmentId: null,
        closedAt: end,
        closureReason: 'APPLICATION_REJECTED',
      });
      s.appointments[0].appointment!.interestState = state;
      const applicant = project(s, end, 'applicant');
      const provider = project(s, end, 'provider');
      expect(applicant.obligations).toEqual([]);
      expect(provider.obligations).toEqual([]);
      expect(capability(applicant, 'SUBMIT_INTEREST')?.allowed).toBe(false);
      expect(capability(provider, 'SET_CONSIDERATION')?.allowed).toBe(false);
      expect(capability(provider, 'INVITE')?.allowed).toBe(true);
    },
  );
  it('keeps binding commitment and applicant replacement separately with exact actor and IDs', () => {
    const p = project(
      source({
        workflow: workflow({ pendingProposalId: 'proposal' }),
        pending: proposal(),
      }),
    );
    expect(p.confirmedAppointment?.appointmentId).toBe('appointment');
    expect(p.pendingProposal?.message).toBe('Please meet later');
    expect(p.nextObligation).toMatchObject({
      action: 'PROVIDER_RESPOND_TO_CHANGE_REQUEST',
      responsibleSide: 'PROVIDER',
      target: {
        applicationId: 'application',
        workflowId: 'workflow',
        proposalId: 'proposal',
        appointmentId: 'appointment',
        section: 'VIEWING',
        action: 'RESPOND_TO_PROPOSAL',
      },
    });
    expect(capability(p, 'ACCEPT_PROPOSAL')?.allowed).toBe(true);
  });
  it('directs provider invitations to applicant', () => {
    const p = project(
      source({
        workflow: workflow({
          confirmedAppointmentId: null,
          pendingProposalId: 'proposal',
        }),
        appointments: [],
        pending: proposal({
          proposerSide: 'PROVIDER',
          responderSide: 'APPLICANT',
          baseAppointmentId: null,
        }),
      }),
      now,
      'applicant',
    );
    expect(p.nextObligation?.responsibleSide).toBe('APPLICANT');
    expect(capability(p, 'ACCEPT_PROPOSAL')?.allowed).toBe(true);
    expect(p.nextRevalidateAt).toEqual(new Date('2027-01-01T22:00:00Z'));
  });
  it('expires attention on deadline without mutating stored proposal or losing appointment', () => {
    const s = source({
      pending: proposal(),
      workflow: workflow({ pendingProposalId: 'proposal' }),
    });
    const p = project(s, new Date('2027-01-01T22:00:00Z'));
    expect(p.obligations).toEqual([]);
    expect(p.pendingProposal).toMatchObject({
      resolution: 'PENDING',
      effectiveResolution: 'EXPIRED',
    });
    expect(capability(p, 'ACCEPT_PROPOSAL')?.blockedReason).toBe(
      'PROPOSAL_EXPIRED',
    );
    expect(p.confirmedAppointment?.appointmentId).toBe('appointment');
    expect(s.pending?.resolution).toBe('PENDING');
  });
  it('keeps confirmed visit visible after attention clears', () => {
    expect(project().obligations).toEqual([]);
    expect(project().confirmedAppointment?.startsAt).toEqual(start);
  });
  it('uses exact 6h boundary and keeps late cancellation available until start', () => {
    const before = project(
      source(),
      new Date(start.getTime() - 6 * 3600000 - 1),
      'applicant',
    );
    expect(capability(before, 'PROPOSE_REPLACEMENT')?.allowed).toBe(true);
    expect(before.nextRevalidateAt).toEqual(
      new Date(start.getTime() - 6 * 3600000),
    );
    const at = project(
      source(),
      new Date(start.getTime() - 6 * 3600000),
      'applicant',
    );
    expect(capability(at, 'PROPOSE_REPLACEMENT')?.blockedReason).toBe(
      'APPLICANT_CHANGE_CUTOFF_PASSED',
    );
    expect(capability(at, 'CANCEL_APPOINTMENT')?.allowed).toBe(true);
    expect(at.nextRevalidateAt).toEqual(start);
    expect(
      capability(project(source(), start, 'applicant'), 'CANCEL_APPOINTMENT')
        ?.blockedReason,
    ).toBe('APPOINTMENT_ALREADY_STARTED');
  });
  it('switches start to end revalidation then asks provider for attendance', () => {
    expect(project(source(), start).nextRevalidateAt).toEqual(end);
    expect(project(source(), end).nextObligation).toMatchObject({
      action: 'PROVIDER_RECORD_VIEWING_OUTCOME',
      target: { appointmentId: 'appointment' },
    });
  });
  it.each(['APPLICANT', 'PROVIDER', 'BOTH'] as const)(
    'keeps attributed %s absence separate from cancellation',
    (absenceSide) => {
      const a = appointment({
        status: 'NO_SHOW',
        outcomes: [
          {
            id: 'outcome',
            viewingId: 'appointment',
            revision: 1,
            outcome: 'NO_SHOW',
            absenceSide,
            correctionReason: null,
            recordedAt: end,
          },
        ],
      });
      const p = project(
        source({
          workflow: workflow({ confirmedAppointmentId: null }),
          appointments: [a],
        }),
        end,
      );
      expect(p.outcome).toMatchObject({
        outcome: 'NO_SHOW',
        absenceSide,
        startsAt: start,
      });
      expect(p.latestAppointment?.cancellation).toBeNull();
    },
  );
  it.each(['APPLICANT', 'PROVIDER'] as const)(
    'exposes structured %s cancellation without attendance obligation',
    (by) => {
      const a = appointment({ status: 'CANCELLED', cancelledAt: now });
      a.appointment = {
        ...a.appointment!,
        cancelledBy: by,
        cancellationReason:
          by === 'APPLICANT' ? 'APPLICANT_CANCELLED' : 'PROVIDER_ILLNESS',
        lateCancellation: true,
      };
      const p = project(
        source({
          workflow: workflow({ confirmedAppointmentId: null }),
          appointments: [a],
        }),
      );
      expect(p.latestAppointment?.cancellation).toMatchObject({
        by,
        late: true,
      });
      expect(p.obligations).toEqual([]);
    },
  );
  it('exposes simultaneous interest and consideration obligations once each', () => {
    const p = project(completed(), end);
    expect(p.obligations.map((o) => o.action)).toEqual([
      'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
      'PROVIDER_DECIDE_CONSIDERATION',
    ]);
    expect(p.applicantInterest?.deadlineAt).toEqual(
      new Date(end.getTime() + 48 * 3600000),
    );
    expect(
      project(completed(), new Date(end.getTime() + 24 * 3600000), 'applicant')
        .nextRevalidateAt,
    ).toEqual(new Date(end.getTime() + 48 * 3600000));
    expect(p.nextRevalidateAt).toEqual(new Date(end.getTime() + 24 * 3600000));
  });
  it('removes expired interest obligation and exposes pending lifecycle expiry', () => {
    const p = project(
      completed(),
      new Date(end.getTime() + 48 * 3600000),
      'applicant',
    );
    expect(p.applicantInterest).toMatchObject({
      state: 'EXPIRED',
      storedState: 'PENDING',
      lifecycleExpiryPending: true,
    });
    expect(p.obligations.some((o) => o.responsibleSide === 'APPLICANT')).toBe(
      false,
    );
    expect(capability(p, 'SUBMIT_INTEREST')?.blockedReason).toBe(
      'INTEREST_RESPONSE_EXPIRED',
    );
    expect(p.obligations).toEqual([]);
    expect(p.nextRevalidateAt).toBeNull();
    expect(capability(p, 'INVITE')?.blockedReason).toBe(
      'INTEREST_RESPONSE_EXPIRED',
    );
    expect(
      capability(
        project(completed(), new Date(end.getTime() + 48 * 3600000)),
        'SET_CONSIDERATION',
      )?.allowed,
    ).toBe(false);
  });
  it('resolved provider undecided is a decision, not perpetual attention', () => {
    const s = completed();
    s.workflow = workflow({
      confirmedAppointmentId: null,
      considerationDecidedAt: end,
    });
    s.considerationAppointmentId = 'appointment';
    const p = project(s, end);
    expect(p.obligations.map((o) => o.action)).toEqual([
      'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
    ]);
    expect(p.providerConsideration).toMatchObject({
      state: 'UNDECIDED',
      decisionRequired: false,
    });
  });
  it('does not reuse an older consideration decision for a later completed visit', () => {
    const s = completed();
    s.workflow = workflow({
      confirmedAppointmentId: null,
      considerationDecidedAt: now,
      providerConsideration: 'CONTINUE_CONSIDERING',
    });
    expect(project(s, end).providerConsideration).toMatchObject({
      appointmentId: null,
      decisionRequired: true,
    });
  });
  it('keeps history and closure while disabling calendar actions after lifecycle end and restore', () => {
    const s = source({
      workflow: workflow({
        state: 'CLOSED',
        closureReason: 'APPLICATION_REJECTED',
        closedAt: now,
        confirmedAppointmentId: null,
      }),
      appointments: [appointment({ status: 'CANCELLED' })],
    });
    expect(project(s, now, 'provider', false)).toMatchObject({
      confirmedAppointment: null,
      obligations: [],
      closure: { reason: 'APPLICATION_REJECTED' },
    });
    expect(capability(project(s), 'INVITE')?.allowed).toBe(true);
    expect(project(s).confirmedAppointment).toBeNull();
  });
  it('retains attendance obligation after terminal closure for already started appointment', () => {
    const s = source({
      workflow: workflow({
        state: 'CLOSED',
        confirmedAppointmentId: null,
        closureReason: 'APPLICATION_REJECTED',
        closedAt: start,
      }),
      appointments: [appointment({ status: 'OUTCOME_PENDING' })],
    });
    const p = project(s, end, 'provider', false);
    expect(capability(p, 'RECORD_OUTCOME')?.allowed).toBe(true);
    expect(p.obligations).toHaveLength(1);
  });
  it('does not invent pending alternative, deadline, or absence attribution for LEGACY imports', () => {
    const s = source({
      workflow: workflow({ mode: 'LEGACY', pendingProposalId: 'stale' }),
      pending: proposal(),
      appointments: [appointment({ appointment: null })],
    });
    const p = project(s);
    expect(p).toMatchObject({
      mode: 'LEGACY',
      pendingProposal: null,
      changeCutoffAt: null,
      applicantInterest: null,
      nextRevalidateAt: end,
    });
    expect(p.confirmedAppointment).toBeNull();
    expect(p.capabilities.every((c) => !c.allowed)).toBe(true);
  });
  it.each([
    ['PROPOSED', 'APPLICANT_RESPOND_TO_VIEWING'],
    ['CHANGE_REQUESTED', 'PROVIDER_RESPOND_TO_CHANGE_REQUEST'],
    ['ACCEPTED', 'PROVIDER_RECORD_VIEWING_OUTCOME'],
    ['OUTCOME_PENDING', 'PROVIDER_RECORD_VIEWING_OUTCOME'],
  ] as const)(
    'projects live %s after closed LEGACY restore without reviving old interest',
    (status, action) => {
      const s = completed();
      s.workflow = workflow({
        mode: 'LEGACY',
        state: 'CLOSED',
        closureReason: 'APPLICATION_REJECTED',
        closedAt: end,
        confirmedAppointmentId: null,
      });
      const liveStart = new Date('2027-01-05T10:00:00Z');
      const liveEnd = new Date('2027-01-05T10:30:00Z');
      const live = appointment({
        id: 'new',
        round: 2,
        status,
        startsAt: liveStart,
        endsAt: liveEnd,
        appointment: null,
        acceptedAt:
          status === 'ACCEPTED' || status === 'OUTCOME_PENDING' ? now : null,
      });
      s.appointments.push(live);
      const at =
        status === 'PROPOSED' || status === 'CHANGE_REQUESTED'
          ? new Date('2027-01-04T10:00:00Z')
          : liveEnd;
      expect(project(s, at).obligations.map((o) => o.action)).toEqual([action]);
      expect(project(s, at, 'provider', false).obligations).toEqual([]);
      const reads = new ApplicationViewingReadService(
        new ApplicationViewingPolicy(),
      );
      const summary = reads.summary(
        s.appointments,
        true,
        2,
        at,
        status === 'PROPOSED' ? 'applicant' : 'provider',
        s,
      );
      expect(summary.nextAction).toBe(action);
      expect(summary.pendingInterest?.capabilities.canSubmitInterest).toBe(
        false,
      );
      if (status === 'PROPOSED')
        expect(summary.latest?.capabilities.canAccept).toBe(true);
      if (status === 'ACCEPTED' || status === 'OUTCOME_PENDING')
        expect(summary.latest?.capabilities.canMarkCompleted).toBe(true);
    },
  );

  it.each([false, true])(
    'allows the new completed LEGACY visit after closure (responded=%s)',
    (responded) => {
      const s = completed();
      s.workflow = workflow({
        mode: 'LEGACY',
        state: 'CLOSED',
        closedAt: now,
        closureReason: 'APPLICATION_REJECTED',
        confirmedAppointmentId: null,
      });
      s.appointments[0].appointment = null;
      if (responded)
        s.appointments[0].interest = {
          id: 'response',
          viewingId: 'appointment',
          interest: 'STILL_INTERESTED',
          respondedAt: end,
        };
      const p = project(s, end, 'applicant');
      expect(p.applicantInterest).toMatchObject({
        state: responded ? 'STILL_INTERESTED' : 'LEGACY_UNANSWERED',
        deadlineAt: null,
      });
      expect(p.obligations.map((o) => o.action)).toEqual(
        responded ? [] : ['APPLICANT_CONFIRM_POST_VIEWING_INTEREST'],
      );
      const reads = new ApplicationViewingReadService(
        new ApplicationViewingPolicy(),
      );
      expect(
        reads.summary(s.appointments, true, 1, end, 'applicant', s)
          .pendingInterest?.capabilities.canSubmitInterest ?? false,
      ).toBe(!responded);
      expect(project(s, end, 'applicant', false).obligations).toEqual([]);
    },
  );

  it.each(['OPEN', 'CLOSED'] as const)(
    'keeps explicitly closed LEGACY appointment interest blocked on %s workflow',
    (state) => {
      const s = completed();
      s.workflow = workflow({
        mode: 'LEGACY',
        state,
        closedAt: state === 'CLOSED' ? now : null,
        confirmedAppointmentId: null,
      });
      s.appointments[0].appointment!.interestState = 'CLOSED';
      const p = project(s, end, 'applicant');
      expect(p.obligations).toEqual([]);
      expect(p.applicantInterest?.state).toBe('CLOSED');
      expect(
        new ApplicationViewingReadService(
          new ApplicationViewingPolicy(),
        ).summary(s.appointments, true, 1, end, 'applicant', s).pendingInterest
          ?.capabilities.canSubmitInterest,
      ).toBe(false);
    },
  );

  it.each([-1, 0, 1])(
    'does not reopen old LEGACY interest when attendance is recorded around closure (%s ms)',
    (offset) => {
      const s = completed();
      s.workflow = workflow({
        mode: 'LEGACY',
        state: 'CLOSED',
        closedAt: end,
        confirmedAppointmentId: null,
      });
      s.appointments[0].appointment = null;
      s.appointments[0].outcomes[0].recordedAt = new Date(
        end.getTime() + offset,
      );
      expect(
        project(s, new Date(end.getTime() + 1000), 'applicant').obligations,
      ).toEqual([]);
      expect(project(s, end, 'applicant').applicantInterest?.state).toBe(
        'CLOSED',
      );
    },
  );

  it('closes an unanswered new LEGACY visit on a later restore without rewriting historical closedAt', () => {
    const s = completed();
    s.workflow = workflow({
      mode: 'LEGACY',
      state: 'CLOSED',
      closedAt: now,
      updatedAt: new Date(end.getTime() + 3600000),
      confirmedAppointmentId: null,
    });
    s.appointments[0].appointment = null;
    expect(project(s, s.workflow.updatedAt, 'applicant').obligations).toEqual(
      [],
    );
    expect(
      project(s, s.workflow.updatedAt, 'applicant').applicantInterest?.state,
    ).toBe('CLOSED');
  });

  it('does not revive legacy post-viewing obligations after lifecycle closure or restore', () => {
    const s = completed();
    s.workflow = workflow({
      mode: 'LEGACY',
      state: 'CLOSED',
      closureReason: 'APPLICATION_REJECTED',
      closedAt: end,
      confirmedAppointmentId: null,
    });
    const p = project(s, end);
    expect(p.obligations).toEqual([]);
    expect(p.applicantInterest?.state).toBe('CLOSED');
    const reads = new ApplicationViewingReadService(
      new ApplicationViewingPolicy(),
    );
    expect(
      reads.summary(s.appointments, true, 1, end, 'applicant', s)
        .pendingInterest?.capabilities.canSubmitInterest,
    ).toBe(false);
  });
  it('does not reopen old consideration after restore or a fresh invitation', () => {
    const s = completed();
    s.appointments[0].appointment!.interestState = 'CLOSED';
    for (const state of ['CLOSED', 'OPEN'] as const) {
      s.workflow = workflow({ state, confirmedAppointmentId: null });
      const p = project(s, end);
      expect(p.obligations).toEqual([]);
      expect(p.providerConsideration?.decisionRequired).toBe(false);
      expect(capability(p, 'SET_CONSIDERATION')?.blockedReason).toBe(
        'POST_VIEWING_DECISION_CLOSED',
      );
    }
  });
  it('keeps an earlier completed visit decision open when only a later calendar flow was closed', () => {
    const s = completed();
    s.workflow = workflow({
      state: 'CLOSED',
      closureReason: 'PROVIDER_CLOSED',
      closedAt: end,
      confirmedAppointmentId: null,
    });
    const p = project(s, end);
    expect(p.obligations).toHaveLength(2);
    expect(capability(p, 'SET_CONSIDERATION')?.allowed).toBe(true);
    expect(
      capability(project(s, end, 'applicant'), 'SUBMIT_INTEREST')?.allowed,
    ).toBe(true);
  });
  it.each(['NORMAL', 'SHORT_NOTICE', 'LEGACY'] as const)(
    'keeps confirmed %s timing visible beside a replacement',
    (timing) => {
      const s = source({
        pending: proposal(),
        confirmedProposal: proposal({
          id: 'original',
          round: 1,
          timing,
          resolution: 'ACCEPTED',
        }),
      });
      expect(project(s).confirmedAppointment).toMatchObject({
        timing,
        shortNotice: timing === 'LEGACY' ? null : timing === 'SHORT_NOTICE',
      });
    },
  );
  it('keeps EMPTY application identity and permits provider initiation only', () => {
    const s = source({
      workflow: null,
      appointments: [],
      latestAcceptedId: null,
    });
    expect(project(s)).toMatchObject({
      applicationId: 'application',
      mode: 'EMPTY',
    });
    expect(capability(project(s), 'INVITE')?.allowed).toBe(true);
    expect(capability(project(s, now, 'applicant'), 'INVITE')?.allowed).toBe(
      false,
    );
  });
  it('feeds exact targets to deduplicated current attention without the legacy ledger obligation', () => {
    const reads = new ApplicationViewingReadService(
      new ApplicationViewingPolicy(),
    );
    const s = completed();
    const facts = reads.facts(s.appointments, true, 1, end, s);
    const pending = new ApplicationPendingActionService();
    const result = pending.derive(
      { id: 'application', status: 'ACTIVE', listing: { status: 'PUBLISHED' } },
      'provider',
      emptyConversationFacts,
      [],
      [...facts, ...facts],
      end,
    );
    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions[0]).toMatchObject({
      type: 'DECIDE_VIEWING_CONSIDERATION',
      target: {
        workflowTarget: {
          workflowId: 'workflow',
          appointmentId: 'appointment',
          action: 'PROVIDER_CONSIDERATION',
        },
      },
    });
  });
});
