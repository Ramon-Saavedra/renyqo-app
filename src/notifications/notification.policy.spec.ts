import { notifiableActivity } from './notification.policy';
import type { AppendApplicationActivityInput } from '../applications/application-activity.service';
const input = (
  patch: Partial<AppendApplicationActivityInput> = {},
): AppendApplicationActivityInput => ({
  applicationId: 'app',
  actorType: 'PROVIDER',
  type: 'VIEWING_PROPOSED',
  visibility: 'BOTH',
  ...patch,
});
describe('Deliberate bell notification policy', () => {
  it.each([
    'VIEWING_PROPOSED',
    'VIEWING_ACCEPTED',
    'VIEWING_DECLINED',
    'VIEWING_CHANGE_REQUESTED',
    'VIEWING_REPLACEMENT_PROPOSED',
    'VIEWING_PROPOSAL_WITHDRAWN',
    'VIEWING_CANCELLED',
    'VIEWING_COMPLETED',
    'VIEWING_NO_SHOW',
    'VIEWING_OUTCOME_CORRECTED',
    'VIEWING_INTEREST_CONFIRMED',
    'VIEWING_PROPOSAL_EXPIRED',
    'APPLICATION_REJECTED',
    'APPLICATION_RESTORED',
    'APPLICATION_WITHDRAWN',
    'APPLICATION_ACCEPTED',
    'APPLICATION_PROMOTED_TO_ACTIVE',
  ] as const)('includes meaningful %s', (type) =>
    expect(
      notifiableActivity(
        input({
          type,
          metadata: { appointmentId: 'appointment', proposalId: 'proposal' },
        }),
      ),
    ).toBe(true),
  );
  it.each([
    'APPLICATION_SUBMITTED',
    'VIEWING_RESCHEDULED',
    'VIEWING_INTEREST_DECLINED',
    'VIEWING_INTEREST_EXPIRED',
    'VIEWING_WORKFLOW_CLOSED',
    'VIEWING_CONSIDERATION_CHANGED',
  ] as const)('suppresses duplicate/internal %s', (type) =>
    expect(notifiableActivity(input({ type }))).toBe(false),
  );
  it('suppresses internal visibility, undecided and the decline half of a counterproposal', () => {
    expect(notifiableActivity(input({ type: 'VIEWING_CANCELLED' }))).toBe(
      false,
    );
    expect(notifiableActivity(input({ visibility: 'INTERNAL' }))).toBe(false);
    expect(
      notifiableActivity(
        input({
          type: 'VIEWING_DECLINED',
          metadata: { counterproposal: true },
        }),
      ),
    ).toBe(false);
    expect(
      notifiableActivity(
        input({
          type: 'VIEWING_CONSIDERATION_CHANGED',
          metadata: { providerConsideration: 'UNDECIDED' },
        }),
      ),
    ).toBe(false);
    expect(
      notifiableActivity(
        input({
          type: 'VIEWING_CONSIDERATION_CHANGED',
          metadata: { providerConsideration: 'CONTINUE_CONSIDERING' },
        }),
      ),
    ).toBe(true);
  });
  it('includes a listing closure only when it actually affects a viewing commitment', () => {
    const metadata = {
      viewingClosureReason: 'LISTING_ARCHIVED' as const,
      appointmentId: 'appointment',
    };
    expect(
      notifiableActivity(input({ type: 'VIEWING_WORKFLOW_CLOSED', metadata })),
    ).toBe(true);
    expect(
      notifiableActivity(
        input({
          type: 'VIEWING_WORKFLOW_CLOSED',
          metadata: { ...metadata, appointmentId: undefined },
        }),
      ),
    ).toBe(false);
    expect(
      notifiableActivity(
        input({
          type: 'VIEWING_WORKFLOW_CLOSED',
          metadata: {
            ...metadata,
            viewingClosureReason: 'APPLICATION_REJECTED',
          },
        }),
      ),
    ).toBe(false);
  });
});
