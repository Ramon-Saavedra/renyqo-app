export type ListingAssignmentReason =
  'INITIAL' | 'OWNER_REASSIGNMENT' | 'APPROVED_TRANSFER' | 'MEMBERSHIP_REMOVAL';
export type ListingTransferStatus =
  'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

export interface AssignmentCommand {
  workspaceId: string;
  listingId: string;
  targetMembershipId: string;
  expectedListingRevision: number;
  commandId: string;
  correlationId?: string;
}

export interface AssignmentListing {
  id: string;
  workspace_id: string;
  responsible_membership_id: string;
  revision: number;
  status: string;
}
