import type { Prisma } from '../generated/prisma/client';
import type { AppendApplicationActivityInput } from '../applications/application-activity.service';

/** Deliberate product allowlist. Internal closure/reschedule entries are not inbox items. */
const types = new Set([
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
]);
export function notifiableActivity(input: AppendApplicationActivityInput) {
  if (input.visibility === 'INTERNAL') return false;
  if (
    input.type === 'VIEWING_CANCELLED' &&
    !(
      input.metadata?.appointmentId ||
      input.metadata?.proposalId ||
      input.metadata?.viewingId
    )
  )
    return false;
  if (input.type === 'VIEWING_DECLINED' && input.metadata?.counterproposal)
    return false;
  if (input.type === 'VIEWING_WORKFLOW_CLOSED')
    return (
      !!(input.metadata?.proposalId || input.metadata?.appointmentId) &&
      ['LISTING_ARCHIVED', 'LISTING_UNPUBLISHED'].includes(
        input.metadata?.viewingClosureReason ?? '',
      )
    );
  return (
    types.has(input.type) ||
    (input.type === 'VIEWING_CONSIDERATION_CHANGED' &&
      input.metadata?.providerConsideration === 'CONTINUE_CONSIDERING')
  );
}

/** Used by list, count and read writes; hidden rows never contribute to the bell. */
export function visibleNotifications(
  userId: string,
  now: Date,
): Prisma.NotificationWhereInput {
  return {
    recipientId: userId,
    expiresAt: { gt: now },
    recipient: { status: 'ACTIVE' },
    OR: [
      {
        recipientSide: 'APPLICANT',
        recipient: { role: 'APPLICANT' },
        application: { applicantId: userId },
      },
      {
        recipientSide: 'PROVIDER',
        recipient: { role: 'PROVIDER' },
        application: {
          listing: { providerId: userId },
          status: { not: 'WAITING' },
          OR: [{ status: 'ACTIVE' }, { activeAt: { not: null } }],
        },
      },
    ],
  };
}
