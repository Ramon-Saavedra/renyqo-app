import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  organizationLegalName,
  workspaceDisplayName,
} from './domain/workspace-policy';
import { WorkspaceRepository } from './persistence/workspace.repository';
import { MembershipIdentityRepository } from './persistence/membership-identity.repository';
import { PersonalAllocationRepository } from './persistence/personal-allocation.repository';
import { OrganizationProfileRepository } from './persistence/organization-profile.repository';

export type EstablishWorkspace = {
  workspaceId: string;
  membershipId: string;
  userId: string;
  displayName: string;
} & (
  | { kind: 'PERSONAL'; allocationId: string }
  | { kind: 'ORGANIZATION'; legalName: string | null }
);

// Internal persistence foundation, NOT an authorized command endpoint. Caller
// owns the transaction and must enforce current auth, eligibility, entitlements
// and required audit before enabling any operational use. No default adapters.
@Injectable()
export class WorkspaceEstablishment {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: MembershipIdentityRepository,
    private readonly allocations: PersonalAllocationRepository,
    private readonly profiles: OrganizationProfileRepository,
  ) {}

  async withinTransaction(
    tx: Prisma.TransactionClient,
    input: EstablishWorkspace,
  ) {
    const displayName = workspaceDisplayName(input.displayName);
    const legalName =
      input.kind === 'ORGANIZATION'
        ? organizationLegalName(input.legalName)
        : null;
    // A stable caller-supplied workspace ID is the establishment retry key.
    // Serialize same-ID retries, including when no row exists yet.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 451))`;
    const existing = await this.workspaces.find(tx, input.workspaceId);
    if (existing) {
      const owner = await this.memberships.findOwner(tx, existing.id);
      const detail =
        input.kind === 'PERSONAL'
          ? await this.allocations.find(
              tx,
              input.workspaceId,
              input.allocationId,
            )
          : await this.profiles.find(tx, existing.id);
      const matchesDetail =
        input.kind === 'PERSONAL'
          ? detail &&
            'userId' in detail &&
            detail.workspaceId === existing.id &&
            detail.userId === input.userId &&
            detail.releasedAt === null
          : detail && 'legalName' in detail && detail.legalName === legalName;
      if (
        existing.revision !== 1 ||
        existing.kind !== input.kind ||
        existing.displayName !== displayName ||
        existing.lifecycleStatus !== 'ACTIVE' ||
        owner?.id !== input.membershipId ||
        owner.userId !== input.userId ||
        !matchesDetail
      )
        throw new ConflictException(
          'Workspace establishment conflicts with existing state',
        );
      return existing;
    }
    const workspace = await this.workspaces.create(tx, {
      id: input.workspaceId,
      kind: input.kind,
      displayName,
    });
    await this.memberships.establishOwner(tx, {
      id: input.membershipId,
      workspaceId: workspace.id,
      userId: input.userId,
      displayColor: '#2563EB',
    });
    if (input.kind === 'PERSONAL') {
      await this.allocations.allocate(tx, {
        id: input.allocationId,
        workspaceId: workspace.id,
        userId: input.userId,
      });
    } else {
      await this.profiles.create(tx, workspace.id, legalName);
    }
    return workspace;
  }
}
