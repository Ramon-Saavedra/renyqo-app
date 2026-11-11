import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import type { AssignmentListing } from './assignment.types';

export function assertAssignmentListing(
  context: AuthorizationContext,
  listing: AssignmentListing,
  expectedRevision: number,
) {
  if (context.workspaceId !== listing.workspace_id)
    throw new ForbiddenException('Listing is inaccessible');
  if (context.workspaceLifecycle !== 'ACTIVE' || listing.status === 'retired')
    throw new ConflictException('Listing is not operational');
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    listing.revision !== expectedRevision
  )
    throw new ConflictException('Listing revision changed');
}

export function assertAssignmentOwner(context: AuthorizationContext) {
  if (context.role !== 'OWNER') throw new ForbiddenException('OWNER required');
}
