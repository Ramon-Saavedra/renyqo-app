import { TenantFixture } from './workspace-tenant.fixture';
import { deferred } from './provider-authorization.fixture';
import { delegateContext } from '../src/provider-authorization/domain/authority-reference';

jest.setTimeout(30000);
describe('4.5.3 revocation fences through restricted RLS login', () => {
  let f: TenantFixture;
  let s: Awaited<ReturnType<TenantFixture['subject']>>;
  beforeEach(async () => {
    f = new TenantFixture();
    await f.start();
    s = await f.subject();
    await f.activate();
  });
  afterEach(() => f.stop());
  const kinds = [
    'SUSPENDED',
    'REMOVED',
    'GLOBAL_VERSION',
    'GLOBAL_STATUS',
    'LOGOUT',
    'CLOSING',
  ] as const;

  it.each(kinds)(
    'protected write first: %s waits for outer commit',
    async (kind) => {
      const held = deferred();
      const release = deferred();
      const write = f.mutate(s.authority, s.request, async (ctx, tx) => {
        await f.resourcePolicy(ctx, tx);
        held.resolve();
        await release.promise;
      });
      const result = write.then(
        (value) => ({ value }),
        (error) => ({ error: error as unknown }),
      );
      const c = await f.pool.connect();
      try {
        await held.promise;
        await c.query('BEGIN');
        const pid = (
          await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0].pid;
        const revocation = f.revoke(c, s, kind).then(
          () => null,
          (error) => error as unknown,
        );
        await f.waitBlocked(pid);
        release.resolve();
        expect(await result).toEqual({ value: 1 });
        expect(await revocation).toBeNull();
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

  it.each(kinds)(
    'revocation first: %s defeats stale write and fresh Serializable retry',
    async (kind) => {
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
        const result = f.mutate(s.authority, s.request).then(
          () => null,
          (error) => error as unknown,
        );
        await f.waitBlocked(await started.promise);
        await c.query('COMMIT');
        expect(await result).not.toBeNull();
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(await f.value(s.resourceId)).toBe(0);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    },
  );

  it('USER_DELEGATED survives logout but not global revocation', async () => {
    const ctx = await f.resolver.read(
      f.runtime,
      s.authority,
      s.request,
      (current) => Promise.resolve(current),
    );
    const delegated = delegateContext(ctx, s.request);
    expect(await f.mutate(delegated, s.request)).toBe(1);
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: s.authority.sessionId },
    });
    await expect(f.mutate(s.authority, s.request)).rejects.toMatchObject({
      status: 401,
    });
    expect(await f.mutate(delegated, s.request)).toBe(2);
    await f.prisma.user.update({
      where: { id: delegated.userId },
      data: { authVersion: { increment: 1 } },
    });
    await expect(f.mutate(delegated, s.request)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('reauthorizes before returning a previously successful protected receipt', async () => {
    let executions = 0;
    const command = () =>
      f.writes.run(
        s.authority,
        s.request,
        { kind: 'BUSINESS' },
        async () => {},
        async (tx) => {
          const [prior] = await tx.$queryRaw<{ protected_result: string }[]>`
        SELECT protected_result FROM authz_test_receipts WHERE workspace_id=${s.w.id}::uuid`;
          if (prior) return prior.protected_result;
          executions++;
          await tx.$executeRaw`INSERT INTO authz_test_receipts(workspace_id,user_id,command_id,action,input_hash,protected_result)
        VALUES(${s.w.id}::uuid,${s.authority.userId}::uuid,${s.resourceId}::uuid,'test','same','protected')`;
          return 'protected';
        },
      );
    expect(await command()).toBe('protected');
    expect(await command()).toBe('protected');
    expect(executions).toBe(1);
    await f.change(s.w.id, s.membershipId, 'SUSPENDED');
    await expect(command()).rejects.toMatchObject({ status: 404 });
    expect(executions).toBe(1);
  });

  it('stale membership epoch and revocation during asynchronous read preparation prevent result production', async () => {
    const entered = deferred();
    const release = deferred();
    let produced = false;
    const result = f.reads
      .query(
        s.authority,
        s.request,
        async () => {
          entered.resolve();
          await release.promise;
        },
        () => {
          produced = true;
          return Promise.resolve('secret');
        },
      )
      .then(
        () => null,
        (error) => error as unknown,
      );
    await entered.promise;
    await f.change(s.w.id, s.membershipId, 'SUSPENDED');
    release.resolve();
    expect(await result).toMatchObject({ status: 404 });
    expect(produced).toBe(false);
    await f.change(s.w.id, s.membershipId, 'ACTIVE');
    await expect(f.mutate(s.authority, s.request)).rejects.toMatchObject({
      status: 403,
    });
  });
});
