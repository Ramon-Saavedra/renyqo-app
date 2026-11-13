import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Prisma } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { MembershipFixture } from './provider-memberships.fixture';
import { GlobalAuthorityReader } from '../src/provider-authorization/persistence/global-authority.reader';
import { WorkspaceAuthorityReader } from '../src/provider-authorization/persistence/workspace-authority.reader';
import { AuthorityLockRepository } from '../src/provider-authorization/persistence/authority-lock.repository';
import { WorkspaceMembershipResolver } from '../src/provider-authorization/workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from '../src/provider-authorization/protected-workspace-transactions';
import { AuthorizedWorkspaceReads } from '../src/provider-authorization/authorized-workspace-reads';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  HumanAuthority,
  SessionAuthority,
  WritePolicy,
} from '../src/provider-authorization/domain/authorization.types';
import { requireVisibleWorkspaceResource } from '../src/provider-authorization/domain/resource-visibility';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ObservedLocks extends AuthorityLockRepository {
  observer?: (pid: number) => void;
  override async global(
    tx: Prisma.TransactionClient,
    authority: HumanAuthority,
    participantUserIds: readonly string[] = [],
  ) {
    const [row] = await tx.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    this.observer?.(row.pid);
    await super.global(tx, authority, participantUserIds);
  }
}

export class AuthorizationFixture extends MembershipFixture {
  readonly globalAuthority = new GlobalAuthorityReader();
  readonly authorityLocks = new ObservedLocks();
  readonly resolver = new WorkspaceMembershipResolver(
    this.globalAuthority,
    new WorkspaceAuthorityReader(),
  );
  get writes() {
    return new ProtectedWorkspaceTransactions(
      this.prisma as PrismaService,
      this.authorityLocks,
      this.globalAuthority,
      this.resolver,
    );
  }
  get reads() {
    return new AuthorizedWorkspaceReads(
      this.prisma as PrismaService,
      this.resolver,
    );
  }

  override async start() {
    await super.start();
    // Test-only canonical resource/receipt fixtures. No production schema or
    // legacy provider ownership is being repurposed as a tenant relation.
    await this.pool
      .query(`CREATE TABLE authz_test_resources(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES provider_workspaces(id), value integer NOT NULL DEFAULT 0);
      CREATE TABLE authz_test_receipts(workspace_id uuid NOT NULL, user_id uuid NOT NULL, command_id uuid NOT NULL, action text NOT NULL, input_hash text NOT NULL, protected_result text NOT NULL, PRIMARY KEY(workspace_id,user_id,command_id));`);
  }

  async session(
    userId: string,
    expiry = new Date(Date.now() + 60000),
  ): Promise<SessionAuthority> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const sid = randomUUID();
    await this.prisma.userSession.create({
      data: {
        sid,
        expire: expiry,
        sess: {
          passport: { user: { id: userId, authVersion: user.authVersion } },
        },
      },
    });
    await this.prisma.sessionAuthGrant.create({
      data: { sid, userId, authVersion: user.authVersion },
    });
    return {
      mode: 'SESSION_BOUND',
      userId,
      authVersion: user.authVersion,
      sessionId: sid,
    };
  }

  async subject(owner = false) {
    const w = await this.organization();
    const membershipId = owner ? w.owner : w.agents[0].id;
    const userId = owner ? w.ownerUser : w.agents[0].userId;
    const authority = await this.session(userId);
    const resourceId = randomUUID();
    await this.pool.query(
      'INSERT INTO authz_test_resources(id,workspace_id) VALUES ($1,$2)',
      [resourceId, w.id],
    );
    const request: AuthorizationRequirement = {
      workspaceId: w.id,
      action: 'test.resource.change',
      resourceIds: [resourceId],
      purpose: 'OPERATIONAL',
      expectedMembershipId: membershipId,
      expectedMembershipRevision: 1,
    };
    return { w, authority, request, membershipId, resourceId };
  }

  readonly resourcePolicy = async (
    context: AuthorizationContext,
    tx: Prisma.TransactionClient,
  ) => {
    const resources = await tx.$queryRaw<
      { id: string; workspaceId: string }[]
    >`SELECT id,workspace_id AS "workspaceId" FROM authz_test_resources WHERE workspace_id=${context.workspaceId}::uuid ORDER BY id FOR UPDATE`;
    requireVisibleWorkspaceResource(context, resources[0] ?? null);
  };

  mutate(
    authority: HumanAuthority,
    request: AuthorizationRequirement,
    policy: WritePolicy = this.resourcePolicy,
  ) {
    return this.writes.run(
      authority,
      request,
      { kind: 'BUSINESS' },
      policy,
      async (tx, context, selection) => {
        const [resource] = await tx.$queryRaw<
          { value: number }[]
        >`UPDATE authz_test_resources SET value=value+1 WHERE id=${selection.resourceIds[0]}::uuid AND workspace_id=${context.workspaceId}::uuid RETURNING value`;
        if (!resource) throw new Error('Test resource not found');
        return resource.value;
      },
    );
  }

  async value(id: string) {
    return (
      await this.pool.query<{ value: number }>(
        'SELECT value FROM authz_test_resources WHERE id=$1',
        [id],
      )
    ).rows[0].value;
  }

  async waitBlocked(pid: number) {
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      const result = await this.pool.query<{ blocked: boolean }>(
        'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
        [pid],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected real PostgreSQL lock contention');
  }

  async revoke(
    c: PoolClient,
    s: Awaited<ReturnType<AuthorizationFixture['subject']>>,
    kind:
      | 'SUSPENDED'
      | 'REMOVED'
      | 'GLOBAL_VERSION'
      | 'GLOBAL_STATUS'
      | 'LOGOUT'
      | 'CLOSING',
  ) {
    if (kind === 'GLOBAL_VERSION')
      await c.query(
        'UPDATE users SET auth_version=auth_version+1 WHERE id=$1',
        [s.authority.userId],
      );
    else if (kind === 'GLOBAL_STATUS')
      await c.query(`UPDATE users SET status='suspended' WHERE id=$1`, [
        s.authority.userId,
      ]);
    else if (kind === 'LOGOUT')
      await c.query('DELETE FROM session_auth_grants WHERE sid=$1', [
        s.authority.sessionId,
      ]);
    else {
      await this.lock(c, s.w.id);
      if (kind === 'CLOSING')
        await c.query(
          `UPDATE provider_workspaces SET lifecycle_status='CLOSING',closing_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,
          [s.w.id],
        );
      else
        await c.query(
          'UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1',
          [s.membershipId, kind],
        );
    }
  }
}
