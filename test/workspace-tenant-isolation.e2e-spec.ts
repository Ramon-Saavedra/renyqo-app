import { randomUUID } from 'node:crypto';
import { TenantFixture } from './workspace-tenant.fixture';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { assertRestrictedWorkspaceRuntime } from '../src/provider-tenancy/runtime-role-verifier';

jest.setTimeout(30000);
describe('Six-table tenant RLS (actual restricted PostgreSQL login)', () => {
  const f = new TenantFixture();
  let a: Awaited<ReturnType<TenantFixture['subject']>>;
  let b: typeof a;
  beforeAll(async () => {
    await f.start();
    a = await f.subject();
    b = await f.subject();
    await f.prisma.workspaceMembership.create({
      data: {
        workspaceId: b.w.id,
        userId: a.authority.userId,
        role: 'AGENT',
        displayColor: '#123456',
      },
    });
    for (const s of [a, b])
      await f.tx((tx) => f.intents.confirmWithinTransaction(tx, f.intent(s.w)));
    await f.activate(1);
  });
  afterAll(() => f.stop());

  it('uses a real NOSUPERUSER NOBYPASSRLS non-owner login and FORCE RLS on all six tables', async () => {
    await expect(
      assertRestrictedWorkspaceRuntime(f.runtime),
    ).resolves.toBeUndefined();
    await expect(assertRestrictedWorkspaceRuntime(f.prisma)).rejects.toThrow(
      'Unsafe',
    );
    const [row] = await f.runtime.$queryRaw<
      { name: string }[]
    >`SELECT current_user AS name`;
    expect(row.name).toBe(f.login);
    for (const sql of [
      'ALTER TABLE provider_workspaces DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE provider_workspaces DISABLE TRIGGER ALL',
      'SET ROLE renyqo_workspace_invariants',
      'SET ROLE renyqo_workspace_owner',
      `SET ROLE renyqo`,
      'TRUNCATE provider_workspaces CASCADE',
      'CREATE TABLE forbidden_runtime_table(id int)',
    ])
      await expect(f.runtimePool.query(sql)).rejects.toBeDefined();
  });

  it('denies missing context through raw SQL and ORM, including root client misuse', async () => {
    expect(await f.runtime.providerWorkspace.findMany()).toEqual([]);
    expect(
      (await f.runtimePool.query('SELECT * FROM workspace_memberships')).rows,
    ).toEqual([]);
    await expect(
      f.runtime.providerWorkspace.create({
        data: { id: randomUUID(), kind: 'ORGANIZATION', displayName: 'Denied' },
      }),
    ).rejects.toBeDefined();
    await expect(
      f.runtime.workspaceOwnershipRevisionBaseline.findMany(),
    ).rejects.toBeDefined();
  });

  it('row_security=off errors instead of bypassing tenant policies', async () => {
    await expect(
      f.runtimeSql(a.w.id, async (c) => {
        await c.query('SET LOCAL row_security=off');
        await c.query('SELECT * FROM provider_workspaces');
      }),
    ).rejects.toBeDefined();
  });

  it('filters SELECT, counts, searches, pagination and foreign IDs across the five runtime tables', async () => {
    await f.scopedRead(a.w.id, async (tx) => {
      expect((await tx.providerWorkspace.findMany()).map((w) => w.id)).toEqual([
        a.w.id,
      ]);
      expect(
        await tx.providerWorkspace.findUnique({ where: { id: b.w.id } }),
      ).toBeNull();
      expect(await tx.organizationProfile.count()).toBe(1);
      expect(await tx.workspaceMembership.count()).toBe(3);
      expect(
        await tx.workspaceMembership.findMany({
          where: { workspaceId: b.w.id },
          take: 1,
        }),
      ).toEqual([]);
      expect(
        await tx.organizationProfile.findMany({
          where: { legalName: { contains: 'Agency' } },
          take: 1,
        }),
      ).toHaveLength(1);
      expect(
        (await tx.ownershipTransferIntent.findMany()).map((i) => i.workspaceId),
      ).toEqual([a.w.id]);
      expect(await tx.personalWorkspaceAllocation.findMany()).toEqual([]);
    });
  });

  it('cannot UPDATE foreign rows, DELETE history, INSERT into a foreign workspace or rewrite tenant identity', async () => {
    await f.runtimeSql(a.w.id, async (c) => {
      expect(
        (
          await c.query(
            'UPDATE provider_workspaces SET revision=revision WHERE id=$1',
            [b.w.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await c.query(
            'UPDATE organization_profiles SET revision=revision+1 WHERE workspace_id=$1',
            [b.w.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    await expect(
      f.runtimeSql(a.w.id, (c) =>
        c.query('DELETE FROM workspace_memberships WHERE workspace_id=$1', [
          b.w.id,
        ]),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.scopedRead(a.w.id, (tx) =>
        tx.workspaceMembership.create({
          data: {
            workspaceId: b.w.id,
            userId: a.authority.userId,
            role: 'AGENT',
            displayColor: '#123456',
          },
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.runtimeSql(a.w.id, (c) =>
        c.query(
          'UPDATE organization_profiles SET workspace_id=$1,revision=revision+1 WHERE workspace_id=$2',
          [b.w.id, a.w.id],
        ),
      ),
    ).rejects.toBeDefined();
  });

  it.each(['malformed', 'stale', 'missing-stamp'])(
    'fails closed for %s context',
    async (mode) => {
      await f.runtimeSql(null, async (c) => {
        await c.query(
          `SELECT set_config('app.workspace_id',$1,true),set_config('app.tenant_xid',$2,true)`,
          [
            mode === 'malformed' ? 'invalid' : a.w.id,
            mode === 'missing-stamp' ? '' : '0',
          ],
        );
        if (mode === 'malformed')
          await c.query(
            `SELECT set_config('app.tenant_xid',pg_current_xact_id()::text,true)`,
          );
        expect(
          (await c.query('SELECT * FROM provider_workspaces')).rows,
        ).toEqual([]);
      });
    },
  );

  it('reuses the same physical backend without leaking after commit, rollback or session poisoning', async () => {
    let pid = 0;
    let priorStamp = '';
    await f.runtimeSql(a.w.id, async (c) => {
      pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
        .rows[0].pid;
      priorStamp = (
        await c.query<{ stamp: string }>(
          `SELECT current_setting('app.tenant_xid') stamp`,
        )
      ).rows[0].stamp;
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([{ id: a.w.id }]);
    });
    await expect(
      f.runtimeSql(a.w.id, () => Promise.reject(new Error('rollback'))),
    ).rejects.toThrow('rollback');
    await f.runtimePool.query(
      `SELECT set_config('app.workspace_id',$1,false),set_config('app.tenant_xid',$2,false)`,
      [a.w.id, priorStamp],
    );
    await f.runtimeSql(null, async (c) => {
      expect(
        (await c.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]
          .pid,
      ).toBe(pid);
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([]);
    });
    await f.runtimeSql(b.w.id, async (c) => {
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([{ id: b.w.id }]);
    });
    expect(
      (await f.runtimePool.query('SELECT id FROM provider_workspaces')).rows,
    ).toEqual([]);
    await f.runtimePool.query('RESET app.workspace_id; RESET app.tenant_xid');
  });

  it('rejects workspace switching inside a scoped transaction', async () => {
    await expect(
      f.scopedRead(a.w.id, (tx) => installTenantContext(tx, b.w.id)),
    ).rejects.toThrow('Cannot switch');
  });

  it('prepared plans re-evaluate tenant context on the same pooled backend', async () => {
    await f.runtimeSql(a.w.id, async (c) => {
      await c.query(
        'PREPARE tenant_rows AS SELECT id FROM provider_workspaces',
      );
      expect((await c.query('EXECUTE tenant_rows')).rows).toEqual([
        { id: a.w.id },
      ]);
    });
    try {
      await f.runtimeSql(null, async (c) => {
        expect((await c.query('EXECUTE tenant_rows')).rows).toEqual([]);
      });
      await f.runtimeSql(b.w.id, async (c) => {
        expect((await c.query('EXECUTE tenant_rows')).rows).toEqual([
          { id: b.w.id },
        ]);
      });
    } finally {
      await f.runtimePool.query('DEALLOCATE tenant_rows');
    }
  });

  it('retains usable existing tenant and bootstrap indexes without adding broad indexes', async () => {
    await f.runtimeSql(a.w.id, async (c) => {
      // Tiny fixtures legitimately choose sequential scans. Disable only for
      // this diagnostic to prove the existing index access paths are usable.
      await c.query('SET LOCAL enable_seqscan=off');
      const plans = [
        await c.query(
          `EXPLAIN (FORMAT JSON) SELECT id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2`,
          [a.w.id, a.authority.userId],
        ),
        await c.query(
          `EXPLAIN (FORMAT JSON) SELECT * FROM organization_profiles WHERE workspace_id=$1`,
          [a.w.id],
        ),
      ];
      for (const result of plans)
        expect(JSON.stringify(result.rows)).toContain('Index');
    });
    await f.runtimeSql(null, async (c) => {
      await c.query(
        `SELECT set_config('app.tenant_xid',pg_current_xact_id()::text,true),set_config('app.bootstrap_user_id',$1,true),set_config('app.bootstrap_workspace_id',$2,true)`,
        [a.authority.userId, a.w.id],
      );
      await c.query('SET LOCAL enable_seqscan=off');
      const plan = await c.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2`,
        [a.w.id, a.authority.userId],
      );
      expect(JSON.stringify(plan.rows)).toContain('Index');
    });
  });

  it('bootstrap sees only the authenticated candidate membership and cannot expose roots or write memberships', async () => {
    await f.runtimeSql(null, async (c) => {
      await c.query(
        `SELECT set_config('app.workspace_id','',true),set_config('app.tenant_xid',pg_current_xact_id()::text,true),
        set_config('app.bootstrap_user_id',$1,true),set_config('app.bootstrap_workspace_id',$2,true)`,
        [a.authority.userId, a.w.id],
      );
      expect(
        (await c.query('SELECT id FROM workspace_memberships')).rows,
      ).toEqual([{ id: a.membershipId }]);
      expect(
        (await c.query('SELECT id FROM provider_workspaces')).rows,
      ).toEqual([]);
      expect(
        (await c.query(`UPDATE workspace_memberships SET status='SUSPENDED'`))
          .rowCount,
      ).toBe(0);
      await c.query(`SELECT set_config('app.bootstrap_workspace_id',$1,true)`, [
        b.w.id,
      ]);
      const candidate = (
        await c.query('SELECT user_id,workspace_id FROM workspace_memberships')
      ).rows;
      expect(candidate).toEqual([
        { user_id: a.authority.userId, workspace_id: b.w.id },
      ]);
      await c.query(`SELECT set_config('app.bootstrap_workspace_id',$1,true)`, [
        randomUUID(),
      ]);
      expect(
        (await c.query('SELECT id FROM workspace_memberships')).rows,
      ).toEqual([]);
    });
  });

  it('returns identical outward denial for unknown and unauthorized workspaces and rejects spoofed membership IDs', async () => {
    for (const workspaceId of [a.w.id, randomUUID()])
      await expect(
        f.mutate(b.authority, { ...b.request, workspaceId }),
      ).rejects.toMatchObject({ status: 404, message: 'Workspace not found' });
    await expect(
      f.mutate(a.authority, {
        ...a.request,
        expectedMembershipId: b.membershipId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('revalidates async reads and synchronous handoff under restricted RLS', async () => {
    const value = await f.reads.query(
      a.authority,
      a.request,
      async () => {},
      async (_ctx, tx) => await tx.organizationProfile.count(),
    );
    expect(value).toBe(1);
    let sent = false;
    await f.reads.handoff(
      a.authority,
      a.request,
      async () => {},
      value,
      () => {
        sent = true;
      },
    );
    expect(sent).toBe(true);
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: a.authority.sessionId },
    });
    await expect(
      f.reads.handoff(
        a.authority,
        a.request,
        async () => {},
        value,
        () => {
          throw new Error('must not send');
        },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
