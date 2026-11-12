import type { ListingTransferRequest } from '../../generated/prisma/client';
import type { AssignmentListing } from '../domain/assignment.types';

export class ListingResponsibilityResponseDto {
  readonly listingId: string;
  readonly workspaceId: string;
  readonly responsibleMembershipId: string;
  readonly revision: number;

  constructor(listing: AssignmentListing) {
    this.listingId = listing.id;
    this.workspaceId = listing.workspace_id;
    this.responsibleMembershipId = listing.responsible_membership_id;
    this.revision = listing.revision;
  }
}

type PublicTransfer = Pick<
  ListingTransferRequest,
  | 'id'
  | 'listingId'
  | 'workspaceId'
  | 'status'
  | 'sourceMembershipId'
  | 'targetMembershipId'
  | 'expiresAt'
  | 'createdAt'
>;

export class ListingTransferRequestResponseDto implements PublicTransfer {
  readonly id: string;
  readonly listingId: string;
  readonly workspaceId: string;
  readonly status: PublicTransfer['status'];
  readonly sourceMembershipId: string;
  readonly targetMembershipId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;

  constructor(request: PublicTransfer) {
    this.id = request.id;
    this.listingId = request.listingId;
    this.workspaceId = request.workspaceId;
    this.status = request.status;
    this.sourceMembershipId = request.sourceMembershipId;
    this.targetMembershipId = request.targetMembershipId;
    this.expiresAt = request.expiresAt;
    this.createdAt = request.createdAt;
  }
}
