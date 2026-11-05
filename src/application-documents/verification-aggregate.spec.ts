import {
  applicationVerificationState,
  requirementVerificationState,
} from './verification-aggregate';

const file = (state: string, available = state === 'AVAILABLE') => ({
  id: 'file-1',
  state,
  availableAt: available ? new Date('2026-11-05T00:00:00.000Z') : null,
});

describe('verification aggregate', () => {
  it('classifies an open requirement from its current evidence and latest decision', () => {
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: null,
        decision: null,
      }),
    ).toBe('AWAITING_EVIDENCE');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: file('PROCESSING', false),
        decision: null,
      }),
    ).toBe('PROCESSING');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: file('AVAILABLE'),
        decision: null,
      }),
    ).toBe('AWAITING_DECISION');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: { ...file('AVAILABLE'), id: 'file-1' },
        decision: { outcome: 'SATISFIED', evidenceFileId: 'file-1' },
      }),
    ).toBe('SATISFIED');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: file('AVAILABLE'),
        decision: { outcome: 'NOT_SATISFIED', evidenceFileId: 'file-1' },
      }),
    ).toBe('NOT_SATISFIED');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: null,
        decision: { outcome: 'WAIVED', evidenceFileId: null },
      }),
    ).toBe('WAIVED');
    expect(
      requirementVerificationState({
        lifecycleState: 'OPEN',
        file: file('AVAILABLE'),
        decision: { outcome: 'SATISFIED', evidenceFileId: 'old-file' },
      }),
    ).toBe('AWAITING_DECISION');
  });

  it('does not treat acknowledgement or closed history as an active decision', () => {
    expect(
      requirementVerificationState({
        lifecycleState: 'LEGACY_CLOSED_UNKNOWN',
        file: file('AVAILABLE'),
        decision: { outcome: 'SATISFIED', evidenceFileId: 'file-1' },
      }),
    ).toBeNull();
    for (const lifecycleState of ['CANCELLED', 'SUPERSEDED']) {
      expect(
        requirementVerificationState({
          lifecycleState,
          file: file('AVAILABLE'),
          decision: { outcome: 'NOT_SATISFIED', evidenceFileId: 'file-1' },
        }),
      ).toBeNull();
    }
  });

  it('folds requirement states without giving waiver its own application state', () => {
    expect(applicationVerificationState([])).toBe('NOT_REQUESTED');
    expect(applicationVerificationState(['AWAITING_EVIDENCE'])).toBe(
      'AWAITING_EVIDENCE',
    );
    expect(applicationVerificationState(['PROCESSING'])).toBe('PROCESSING');
    expect(applicationVerificationState(['AWAITING_DECISION'])).toBe(
      'AWAITING_DECISION',
    );
    expect(
      applicationVerificationState(['SATISFIED', 'AWAITING_EVIDENCE']),
    ).toBe('AWAITING_EVIDENCE');
    expect(
      applicationVerificationState(['AWAITING_DECISION', 'NOT_SATISFIED']),
    ).toBe('NOT_SATISFIED');
    expect(applicationVerificationState(['SATISFIED', 'WAIVED'])).toBe(
      'SATISFIED',
    );
    expect(applicationVerificationState(['WAIVED', 'WAIVED'])).toBe(
      'SATISFIED',
    );
    expect(
      applicationVerificationState([
        'SATISFIED',
        'NOT_SATISFIED',
        'AWAITING_EVIDENCE',
      ]),
    ).toBe('NOT_SATISFIED');
  });
});
