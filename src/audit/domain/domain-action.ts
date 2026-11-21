// SQL-derived payload contract. Adapters send evidence IDs, not these payloads.
type InvitationChanges = Readonly<{
  statusBefore: 'PENDING' | null;
  statusAfter: 'PENDING' | 'REVOKED' | 'EXPIRED' | 'ACCEPTED';
  revisionBefore: number | null;
  revisionAfter: number;
}>;
type AssignmentChanges = Readonly<{
  previousMembershipId: string | null;
  newMembershipId: string;
  reason: 'INITIAL' | 'OWNER_REASSIGNMENT' | 'APPROVED_TRANSFER';
}>;
type TransferChanges = Readonly<{
  statusBefore: 'REQUESTED' | null;
  statusAfter: 'REQUESTED' | 'EXPIRED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  sourceMembershipId: string;
  targetMembershipId: string;
}>;
export type DomainAuditPayloads = {
  'provider.invitation.created': InvitationChanges;
  'provider.invitation.resent': InvitationChanges;
  'provider.invitation.revoked': InvitationChanges;
  'provider.invitation.expired': InvitationChanges;
  'provider.invitation.accepted': InvitationChanges;
  'provider.membership.created': Readonly<{
    statusBefore: null;
    statusAfter: 'ACTIVE';
    role: 'AGENT';
    invitationId: string;
  }>;
  'provider.plan.assigned': Readonly<{
    previousPlanVersionId: string | null;
    planVersionId: string | null;
    revision: number;
    mode: 'VOLUNTARY' | 'FORCED';
    source: 'MOCK_DEV' | 'INTERNAL';
  }>;
  'provider.listing_assignment.changed': AssignmentChanges;
  'provider.listing_transfer.requested': TransferChanges;
  'provider.listing_transfer.decided': TransferChanges;
  'provider.listing_transfer.expired': TransferChanges;
};
export const DOMAIN_AUDIT_RESOURCES = {
  'provider.invitation.created': 'INVITATION',
  'provider.invitation.resent': 'INVITATION',
  'provider.invitation.revoked': 'INVITATION',
  'provider.invitation.expired': 'INVITATION',
  'provider.invitation.accepted': 'INVITATION',
  'provider.membership.created': 'MEMBERSHIP',
  'provider.plan.assigned': 'WORKSPACE',
  'provider.listing_assignment.changed': 'LISTING',
  'provider.listing_transfer.requested': 'LISTING_TRANSFER_REQUEST',
  'provider.listing_transfer.decided': 'LISTING_TRANSFER_REQUEST',
  'provider.listing_transfer.expired': 'LISTING_TRANSFER_REQUEST',
} as const satisfies Record<keyof DomainAuditPayloads, string>;
export type DomainAuditAction = keyof DomainAuditPayloads;
// All domain actions use schema version 1 and empty metadata. Effect identity is
// action without "provider." + ":" + resource UUID, scoped by the domain command.
