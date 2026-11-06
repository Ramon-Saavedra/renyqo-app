import { ConflictException } from '@nestjs/common';
import type {
  WorkspaceMembershipRole,
  WorkspaceMembershipStatus,
} from '../../generated/prisma/client';

export function assertMembershipTransition(
  role: WorkspaceMembershipRole,
  from: WorkspaceMembershipStatus,
  to: WorkspaceMembershipStatus,
) {
  if (from === 'REMOVED' && to === 'SUSPENDED')
    throw new ConflictException('Removed membership cannot be suspended');
  if (role === 'OWNER' && to === 'REMOVED')
    throw new ConflictException('Ownership must be transferred before removal');
}

export function consumesSeat(status: WorkspaceMembershipStatus) {
  return status !== 'REMOVED';
}
