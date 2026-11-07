import { randomUUID } from 'node:crypto';
import {
  AuthorizationFixture,
  deferred,
} from './provider-authorization.fixture';
import type { SessionAuthority } from '../src/provider-authorization/domain/authorization.types';
import {
  assertSameCommand,
  bindCommand,
} from '../src/provider-authorization/domain/command-replay.policy';

jest.setTimeout(30000);
describe('Protected transaction commit fence (real PostgreSQL contention)', () => {
  const f = new AuthorizationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  afterEach(() => {
    f.authorityLocks.observer = undefined;
  });
  const revocations = [
    'SUSPENDED',
    'REMOVED',
    'GLOBAL_VERSION',
    'GLOBAL_STATUS',
    'LOGOUT',
    'CLOSING',
  ] as const;

  it.each(revocations)(
    'protected mutation first: %s cannot commit until mutation releases its authority locks',
    async (kind) => {
      const s = await f.subject();
      const held = deferred();
      const release = deferred();
      const write = f.mutate(s.authority, s.request, async (context, tx) => {
        await f.resourcePolicy(context, tx);
        held.resolve();
        await release.promise;
      });
      const writeResult = write.then(
        (value) => ({ value }),
        (error) => ({ error: error as unknown }),
      );
      const c = await f.pool.connect();
      try {
        await held.promise;
        await c.query('BEGIN');
        const pid = (
          await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid;
        const revoke = f.revoke(c, s, kind);
        const revocationOutcome = revoke.then(
          () => null,
          (error) => error as unknown,
        );
        await f.waitBlocked(pid); // Prove revocation really waits, not just promises.
        expect(await f.value(s.resourceId)).toBe(0);
        release.resolve();
        expect(await writeResult).toEqual({ value: 1 });
        expect(await revocationOutcome).toBeNull();
        await c.query('COMMIT');
        await expect(f.mutate(s.authority, s.request)).rejects.toBeDefined();
        expect(await f.value(s.resourceId)).toBe(1);
      } finally {
        release.resolve();
        await c.query('ROLLBACK');
        c.release();
      }
    },
  );

  it.each(revocations)(
    'revocation first: %s defeats a blocked mutation and its fresh Serializable retry',
    async (kind) => {
      const s = await f.subject();
      const c = await f.pool.connect();
      const started = deferred<number>();
      let attempts = 0;
      try {
        await c.query('BEGIN');
        await f.revoke(c, s, kind);
        f.authorityLocks.observer = (pid) => {
          attempts++;
          started.resolve(pid);
        };
        const write = f.mutate(s.authority, s.request);
        const outcome = write.then(
          () => null,
          (error) => error as unknown,
        );
        const pid = await started.promise;
        await f.waitBlocked(pid);
        await c.query('COMMIT');
        expect(await outcome).not.toBeNull();
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(await f.value(s.resourceId)).toBe(0);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    },
  );

  it('locks structural participants before role/status changes without shared-to-exclusive membership upgrades', async () => {
    const s = await f.subject(true);
    const target = s.w.agents[0];
    const request = {
      ...s.request,
      requiredRole: 'OWNER' as const,
      expectedOwnershipRevision: 1,
    };
    await f.writes.run(
      s.authority,
      request,
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: 1,
        membershipIds: [target.id],
      },
      async () => {},
      async (tx) => {
        return f.membershipLifecycle.setSuspendedWithinTransaction(
          tx,
          {
            workspaceId: s.w.id,
            membershipId: target.id,
            expectedOwnershipRevision: 1,
            expectedMembershipRevision: 1,
          },
          true,
        );
      },
    );
    expect(await f.member(target.id)).toMatchObject({
      status: 'SUSPENDED',
      revision: 2,
    });
    expect(await f.member(s.membershipId)).toMatchObject({
      role: 'OWNER',
      status: 'ACTIVE',
      revision: 1,
    });
  });

  it('rolls back protected effects and permits no callback after revoked authority', async () => {
    const s = await f.subject();
    await expect(
      f.writes.run(
        s.authority,
        s.request,
        { kind: 'BUSINESS' },
        f.resourcePolicy,
        async (tx, ctx) => {
          await tx.$executeRaw`UPDATE authz_test_resources SET value=10 WHERE workspace_id=${ctx.workspaceId}::uuid`;
          throw new Error('domain failure');
        },
      ),
    ).rejects.toThrow('domain failure');
    expect(await f.value(s.resourceId)).toBe(0);
    await f.change(s.w.id, s.membershipId, 'SUSPENDED');
    const mutate = jest.fn(() => Promise.resolve(1));
    await expect(
      f.writes.run(
        s.authority,
        s.request,
        { kind: 'BUSINESS' },
        f.resourcePolicy,
        mutate,
      ),
    ).rejects.toBeDefined();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('checks natural session expiry after asynchronous policy waits before mutation', async () => {
    const s = await f.subject();
    const expired = await f.session(
      s.authority.userId,
      new Date(Date.now() + 1500),
    );
    let policyCalls = 0;
    await expect(
      f.mutate(expired, s.request, async (context, tx) => {
        policyCalls++;
        await f.resourcePolicy(context, tx);
        await tx.$queryRaw`SELECT 1 FROM pg_sleep(1.6)`;
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(policyCalls).toBe(1);
    expect(await f.value(s.resourceId)).toBe(0);
  });

  it('reauthorizes an old successful idempotent command before releasing its protected receipt', async () => {
    const s = await f.subject();
    const commandId = randomUUID();
    let executions = 0;
    // Test-only receipt integration: authorization is outside every receipt
    // lookup/replay; no production idempotency infrastructure is added.
    async function command(authority: SessionAuthority, inputHash: string) {
      return f.writes.run(
        authority,
        s.request,
        { kind: 'BUSINESS' },
        async (context, tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${commandId},453))`;
          await f.resourcePolicy(context, tx);
        },
        async (tx, ctx) => {
          const [prior] = await tx.$queryRaw<
            { action: string; input_hash: string; protected_result: string }[]
          >`SELECT action,input_hash,protected_result FROM authz_test_receipts WHERE workspace_id=${ctx.workspaceId}::uuid AND user_id=${ctx.userId}::uuid AND command_id=${commandId}::uuid`;
          const binding = bindCommand(ctx, s.request, commandId, inputHash);
          if (prior) {
            assertSameCommand(binding, {
              ...binding,
              action: prior.action,
              inputFingerprint: prior.input_hash,
            });
            return prior.protected_result;
          }
          await tx.$executeRaw`UPDATE authz_test_resources SET value=value+1 WHERE id=${s.resourceId}::uuid`;
          await tx.$executeRaw`INSERT INTO authz_test_receipts(workspace_id,user_id,command_id,action,input_hash,protected_result) VALUES(${ctx.workspaceId}::uuid,${ctx.userId}::uuid,${commandId}::uuid,${binding.action},${inputHash},'protected-result')`;
          executions++;
          return 'protected-result';
        },
      );
    }
    expect(await command(s.authority, 'same')).toBe('protected-result');
    expect(await command(s.authority, 'same')).toBe('protected-result');
    await expect(command(s.authority, 'changed')).rejects.toThrow(
      'Command input changed',
    );
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: s.authority.sessionId },
    });
    await expect(command(s.authority, 'same')).rejects.toMatchObject({
      status: 401,
    });
    expect(executions).toBe(1);
    expect(await f.value(s.resourceId)).toBe(1);
  });
});
