export const requirementVerificationStates = [
  'AWAITING_EVIDENCE',
  'PROCESSING',
  'AWAITING_DECISION',
  'NOT_SATISFIED',
  'SATISFIED',
  'WAIVED',
] as const;
export type RequirementVerificationState =
  (typeof requirementVerificationStates)[number];

export const applicationVerificationStates = [
  'NOT_REQUESTED',
  'AWAITING_EVIDENCE',
  'PROCESSING',
  'AWAITING_DECISION',
  'NOT_SATISFIED',
  'SATISFIED',
] as const;
export type ApplicationVerificationState =
  (typeof applicationVerificationStates)[number];

type EvidenceFile = {
  id: string;
  state: string;
  availableAt: Date | null;
};
type CurrentDecision = {
  outcome: string;
  evidenceFileId: string | null;
};

/**
 * A processing file is not published evidence. It is classified before the
 * "no published evidence" case; otherwise PROCESSING would be unreachable.
 * A current WAIVED decision resolves the open round even when evidence is absent.
 */
export function requirementVerificationState(input: {
  lifecycleState: string;
  file: EvidenceFile | null;
  decision: CurrentDecision | null;
}): RequirementVerificationState | null {
  if (input.lifecycleState !== 'OPEN') return null;
  const decision = input.decision;
  if (decision?.outcome === 'WAIVED') return 'WAIVED';
  const file = input.file;
  const published = file?.state === 'AVAILABLE' && file.availableAt !== null;
  if (
    decision?.outcome === 'NOT_SATISFIED' &&
    published &&
    decision.evidenceFileId === file?.id
  )
    return 'NOT_SATISFIED';
  if (file?.state === 'PROCESSING') return 'PROCESSING';
  if (!published || !file) return 'AWAITING_EVIDENCE';
  if (decision?.outcome === 'SATISFIED' && decision.evidenceFileId === file.id)
    return 'SATISFIED';
  return 'AWAITING_DECISION';
}

export function applicationVerificationState(
  states: readonly RequirementVerificationState[],
): ApplicationVerificationState {
  if (!states.length) return 'NOT_REQUESTED';
  if (states.includes('NOT_SATISFIED')) return 'NOT_SATISFIED';
  if (states.includes('AWAITING_EVIDENCE')) return 'AWAITING_EVIDENCE';
  if (states.includes('PROCESSING')) return 'PROCESSING';
  if (states.includes('AWAITING_DECISION')) return 'AWAITING_DECISION';
  return 'SATISFIED';
}

export type VisibleDecision = {
  id: string;
  outcome: string;
  evidenceFileId: string | null;
  reason: string | null;
  actorUserId: string;
  decidedAt: Date;
  previousDecisionId: string | null;
};

export function providerDecision(decision: VisibleDecision | null) {
  if (!decision) return null;
  return {
    id: decision.id,
    outcome: decision.outcome,
    evidenceFileId: decision.evidenceFileId,
    reason: decision.reason,
    actorUserId: decision.actorUserId,
    decidedAt: decision.decidedAt,
    previousDecisionId: decision.previousDecisionId,
  };
}
