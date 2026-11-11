import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  AuthorityLockPlan,
  HumanAuthority,
  WritePolicy,
} from './domain/authorization.types';
import {
  assertDelegatedScope,
  captureHumanAuthority,
  isAuthorityId,
} from './domain/authority-reference';
import { captureRequirement } from './domain/workspace-authority.policy';
import { AuthorityLockRepository } from './persistence/authority-lock.repository';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import { MembershipBootstrap } from '../provider-tenancy/membership-bootstrap';

@Injectable()
export class ProtectedWorkspaceTransactions {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AuthorityLockRepository,
    private readonly global: GlobalAuthorityReader,
    private readonly resolver: WorkspaceMembershipResolver,
  ) {}

  async run<T>(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    plan: AuthorityLockPlan,
    policy: WritePolicy,
    mutate: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
      requirement: AuthorizationRequirement,
    ) => Promise<T>,
  ): Promise<T> {
    const principal = captureHumanAuthority(authority);
    const selection = captureRequirement(requirement);
    assertDelegatedScope(principal, selection);
    if (
      plan.kind === 'STRUCTURAL' &&
      (plan.membershipIds.some((id) => !isAuthorityId(id)) ||
        (plan.userIds ?? []).some((id) => !isAuthorityId(id)))
    )
      throw new NotFoundException('Workspace not found');
    const lockPlan: AuthorityLockPlan = Object.freeze(
      plan.kind === 'STRUCTURAL'
        ? {
            ...plan,
            membershipIds: Object.freeze(
              plan.membershipIds.map((id) => id.toLowerCase()),
            ),
            userIds: Object.freeze(
              (plan.userIds ?? []).map((id) => id.toLowerCase()),
            ),
          }
        : { ...plan },
    );
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout='1500ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout='4000ms'`;
      await this.locks.global(
        tx,
        principal,
        lockPlan.kind === 'STRUCTURAL' ? lockPlan.userIds : [],
      );
      await this.global.assert(tx, principal);
      const actorId = await new MembershipBootstrap(this.global).enter(
        tx,
        principal,
        selection.workspaceId,
      );
      await this.locks.workspace(tx, selection.workspaceId, lockPlan);
      // Routing read only: no resource or membership tuple locks before root.
      const actor = await tx.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: selection.workspaceId,
            userId: principal.userId,
          },
        },
        select: { id: true },
      });
      if (!actor) throw new NotFoundException('Workspace not found');
      await this.locks.memberships(
        tx,
        selection.workspaceId,
        actorId,
        lockPlan,
      );
      const context = await this.resolver.resolve(tx, principal, selection);
      // Domain-owned dependency locks and policy run after all authority tiers.
      // There is no default allow policy and no external I/O in this callback.
      await policy(context, tx, selection);
      await this.global.assertSession(tx, principal); // clock after lock/policy waits
      return mutate(tx, context, selection);
    });
  }
}
