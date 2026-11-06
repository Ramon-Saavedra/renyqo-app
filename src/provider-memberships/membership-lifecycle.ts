import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { assertMembershipTransition } from './domain/membership-lifecycle.policy';
import { MembershipRepository } from './persistence/membership.repository';

export interface MembershipChange {
  workspaceId: string;
  membershipId: string;
  expectedOwnershipRevision: number;
  expectedMembershipRevision: number;
}

// Caller-owned transaction. No exports/controllers; these persistence commands
// are unavailable operationally until authenticated orchestration and audit exist.
@Injectable()
export class MembershipLifecycle {
  constructor(private readonly members: MembershipRepository) {}

  async setSuspendedWithinTransaction(
    tx: Prisma.TransactionClient,
    input: MembershipChange,
    suspended: boolean,
  ) {
    await this.members.lockWorkspace(
      tx,
      input.workspaceId,
      input.expectedOwnershipRevision,
    );
    const [m] = await this.members.lockMembers(tx, input.workspaceId, [
      input.membershipId,
    ]);
    if (m.revision !== input.expectedMembershipRevision)
      throw new ConflictException('Membership revision changed');
    const status = suspended ? 'SUSPENDED' : 'ACTIVE';
    assertMembershipTransition(m.role, m.status, status);
    if (m.status === 'REMOVED')
      throw new ConflictException(
        'Reinstatement requires entitlement integration',
      );
    return this.members.setStatus(
      tx,
      input.workspaceId,
      m.id,
      m.revision,
      status,
    );
  }

  remove(): never {
    throw new ServiceUnavailableException(
      'Removal requires authorization, atomic assignment repair and audit integration',
    );
  }

  reinstate(): never {
    throw new ServiceUnavailableException(
      'Reinstatement requires authorization, entitlement seat validation and audit integration',
    );
  }
}
