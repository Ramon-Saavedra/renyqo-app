import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  AuthorityLockPlan,
  HumanAuthority,
} from '../domain/authorization.types';
import { positiveEpoch } from '../domain/authority-reference';

@Injectable()
export class AuthorityLockRepository {
  async global(
    tx: Prisma.TransactionClient,
    authority: HumanAuthority,
  ): Promise<void> {
    // FOR KEY SHARE would NOT fence updates of status/auth_version.
    await tx.$queryRaw`SELECT id FROM users WHERE id=${authority.userId}::uuid FOR SHARE`;
    if (authority.mode === 'SESSION_BOUND')
      await tx.$queryRaw`SELECT sid FROM session_auth_grants WHERE sid=${authority.sessionId} FOR SHARE`;
  }

  async workspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    plan: AuthorityLockPlan,
  ): Promise<void> {
    if (plan.kind === 'STRUCTURAL') {
      if (!positiveEpoch(plan.expectedOwnershipRevision))
        throw new ForbiddenException('Expected ownership revision required');
      await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${workspaceId}::uuid, ${plan.expectedOwnershipRevision}::integer)`;
    } else if (plan.kind === 'BUSINESS') {
      await tx.$queryRaw`SELECT id FROM provider_workspaces WHERE id=${workspaceId}::uuid FOR SHARE`;
    } else throw new ForbiddenException('Unknown lock plan');
  }

  async memberships(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    actorId: string,
    plan: AuthorityLockPlan,
  ): Promise<void> {
    const ids = [
      ...new Set([
        actorId,
        ...(plan.kind === 'STRUCTURAL' ? plan.membershipIds : []),
      ]),
    ];
    const rows =
      plan.kind === 'STRUCTURAL'
        ? await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM workspace_memberships WHERE workspace_id=${workspaceId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`
        : await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM workspace_memberships WHERE workspace_id=${workspaceId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
    if (rows.length !== ids.length)
      throw new NotFoundException('Workspace not found');
  }
}
