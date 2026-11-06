import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { WorkspaceFixture } from './provider-workspaces.fixture';
import { MembershipRepository } from '../src/provider-memberships/persistence/membership.repository';
import { MembershipLifecycle } from '../src/provider-memberships/membership-lifecycle';
import { OwnershipTransferIntents } from '../src/provider-memberships/ownership-transfer-intents';
import { OwnershipTransferIntentRepository } from '../src/provider-memberships/persistence/ownership-transfer-intent.repository';

export class MembershipFixture extends WorkspaceFixture {
  readonly members = new MembershipRepository();
  readonly membershipLifecycle = new MembershipLifecycle(this.members);
  readonly intents = new OwnershipTransferIntents(
    this.members,
    new OwnershipTransferIntentRepository(),
  );

  async organization() {
    const input = this.command(await this.user(), 'ORGANIZATION');
    await this.establish(input);
    const agents = [];
    for (let i = 0; i < 2; i++) {
      agents.push(
        await this.prisma.workspaceMembership.create({
          data: {
            workspaceId: input.workspaceId,
            userId: await this.user(),
            role: 'AGENT',
            displayColor: '#7C3AED',
          },
        }),
      );
    }
    return {
      id: input.workspaceId,
      owner: input.membershipId,
      ownerUser: input.userId,
      agents,
    };
  }

  lock(c: PoolClient, workspaceId: string, revision = 1) {
    return c.query('SELECT lock_workspace_ownership_revision($1, $2)', [
      workspaceId,
      revision,
    ]);
  }

  member(id: string) {
    return this.prisma.workspaceMembership.findUniqueOrThrow({ where: { id } });
  }

  async change(workspaceId: string, id: string, status: string) {
    await this.sqlTransaction(async (c) => {
      await this.lock(c, workspaceId);
      await c.query(
        'UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1',
        [id, status],
      );
    });
  }

  intent(w: Awaited<ReturnType<MembershipFixture['organization']>>) {
    return {
      id: randomUUID(),
      workspaceId: w.id,
      currentOwnerMembershipId: w.owner,
      targetMembershipId: w.agents[0].id,
      outcome: 'DEMOTE_TO_AGENT' as const,
      expectedOwnershipRevision: 1,
      expectedOwnerMembershipRevision: 1,
      expectedTargetMembershipRevision: 1,
      expiresAt: new Date(Date.now() + 60000),
    };
  }
}
