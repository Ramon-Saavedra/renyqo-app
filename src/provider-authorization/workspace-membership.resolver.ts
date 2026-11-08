import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type {
  AuthorizationRequirement,
  HumanAuthority,
} from './domain/authorization.types';
import { captureHumanAuthority } from './domain/authority-reference';
import {
  captureRequirement,
  workspaceContext,
} from './domain/workspace-authority.policy';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import { WorkspaceAuthorityReader } from './persistence/workspace-authority.reader';
import type { PrismaClient } from '../generated/prisma/client';
import { MembershipBootstrap } from '../provider-tenancy/membership-bootstrap';
import { assertDelegatedScope } from './domain/authority-reference';

@Injectable()
export class WorkspaceMembershipResolver {
  constructor(
    private readonly global: GlobalAuthorityReader,
    private readonly snapshots: WorkspaceAuthorityReader,
  ) {}

  // Short, non-locking read transaction; never carry it over external work.
  async read<T>(
    db: Pick<PrismaClient, '$transaction'>,
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    produce: (
      context: Awaited<ReturnType<WorkspaceMembershipResolver['resolve']>>,
      tx: Prisma.TransactionClient,
    ) => Promise<T>,
  ): Promise<T> {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    assertDelegatedScope(principal, selection);
    return db.$transaction(
      async (tx) => {
        await new MembershipBootstrap(this.global).enter(
          tx,
          principal,
          selection.workspaceId,
        );
        return produce(await this.resolve(tx, principal, selection), tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async resolve(
    db: Prisma.TransactionClient,
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
  ) {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    const row = await this.snapshots.read(db, principal, selection.workspaceId);
    this.global.assertFacts(principal, row);
    const membership =
      row?.membershipId &&
      row.role &&
      row.status &&
      row.revision &&
      row.lifecycle &&
      row.ownershipRevision
        ? {
            id: row.membershipId,
            workspaceId: selection.workspaceId,
            userId: principal.userId,
            role: row.role,
            status: row.status,
            revision: row.revision,
            workspace: {
              lifecycleStatus: row.lifecycle,
              ownershipRevision: row.ownershipRevision,
            },
          }
        : null;
    return workspaceContext(principal, selection, membership);
  }
}
