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

@Injectable()
export class WorkspaceMembershipResolver {
  constructor(
    private readonly global: GlobalAuthorityReader,
    private readonly snapshots: WorkspaceAuthorityReader,
  ) {}

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
