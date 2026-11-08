import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { WorkspaceCreation } from '../src/provider-tenancy/workspace-creation';
import { TenantFixture } from './workspace-tenant.fixture';

jest.setTimeout(30000);
describe('Domain invariants under restricted tenant RLS', () => {
  const f = new TenantFixture();
  const subjects: Awaited<ReturnType<TenantFixture['subject']>>[] = [];
  let creator: Awaited<ReturnType<TenantFixture['session']>>;
  let creation: WorkspaceCreation;
  beforeAll(async () => {
    await f.start();
    for (let i = 0; i < 7; i++) subjects.push(await f.subject(true));
    creator = await f.session(await f.user());
    await f.activate();
    creation = new WorkspaceCreation(
      f.runtime as PrismaService,
      f.authorityLocks,
      f.globalAuthority,
      f.establishment,
    );
  });
  afterAll(() => f.stop());

  it('creates the root, first OWNER and evidence atomically with server-generated IDs', async () => {
    const w = await creation.run(
      creator,
      { kind: 'ORGANIZATION', displayName: 'New', legalName: 'New GmbH' },
      async () => {},
    );
    await f.scopedRead(w.id, async (tx) => {
      expect(
        await tx.workspaceMembership.count({ where: { role: 'OWNER' } }),
      ).toBe(1);
      expect(await tx.organizationProfile.count()).toBe(1);
      expect(
        (await tx.providerWorkspace.findUniqueOrThrow({ where: { id: w.id } }))
          .ownershipRevision,
      ).toBe(1);
    });
    await expect(
      creation.run(creator, { kind: 'PERSONAL', displayName: 'Denied' }, () =>
        Promise.reject(new Error('eligibility denied')),
      ),
    ).rejects.toThrow('eligibility denied');
  });

  it('cannot commit zero OWNERs, two OWNERs or a REMOVED OWNER', async () => {
    const s = subjects[0];
    for (const sql of [
      `UPDATE workspace_memberships SET role='AGENT' WHERE id='${s.w.owner}'`,
      `UPDATE workspace_memberships SET role='OWNER' WHERE id='${s.w.agents[0].id}'`,
      `UPDATE workspace_memberships SET status='REMOVED' WHERE id='${s.w.owner}'`,
    ])
      await expect(
        f.runtimeSql(s.w.id, async (c) => {
          await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
            s.w.id,
          ]);
          await c.query(sql);
        }),
      ).rejects.toBeDefined();
    expect((await f.member(s.w.owner)).role).toBe('OWNER');
  });

  it('atomically swaps OWNER once, rejects stale epochs, and prevents raw counter/baseline tampering', async () => {
    const s = subjects[1];
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [s.w.owner],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [s.w.agents[0].id],
      );
    });
    await f.scopedRead(s.w.id, async (tx) => {
      expect(
        (
          await tx.providerWorkspace.findUniqueOrThrow({
            where: { id: s.w.id },
          })
        ).ownershipRevision,
      ).toBe(2);
      expect(
        (
          await tx.workspaceMembership.findUniqueOrThrow({
            where: { id: s.w.owner },
          })
        ).revision,
      ).toBe(2);
    });
    await expect(
      f.runtimeSql(s.w.id, (c) =>
        c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.runtimeSql(s.w.id, (c) =>
        c.query(
          'UPDATE provider_workspaces SET ownership_revision=99 WHERE id=$1',
          [s.w.id],
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.runtimeSql(s.w.id, (c) =>
        c.query('SELECT capture_workspace_ownership_baseline($1,1,false)', [
          s.w.id,
        ]),
      ),
    ).rejects.toBeDefined();
    await expect(
      f.runtimeSql(s.w.id, (c) =>
        c.query(
          'UPDATE workspace_ownership_revision_baselines SET baseline_revision=99',
        ),
      ),
    ).rejects.toBeDefined();
  });

  it('A → B → A has no net ownership revision change and failed transfers roll back', async () => {
    const s = subjects[2];
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [s.w.owner],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [s.w.agents[0].id],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [s.w.agents[0].id],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [s.w.owner],
      );
    });
    await expect(
      f.runtimeSql(s.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          s.w.id,
        ]);
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
          [s.w.owner],
        );
      }),
    ).rejects.toBeDefined();
    expect(
      (
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: s.w.id },
        })
      ).ownershipRevision,
    ).toBe(1);
  });

  it('suspension preserves canonical OWNER and historical members remain visible to full-workspace checks', async () => {
    const s = subjects[3];
    await f.runtimeSql(s.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [s.w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
        [s.w.owner],
      );
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [s.w.agents[0].id],
      );
    });
    await f.scopedRead(s.w.id, async (tx) => {
      expect(await tx.workspaceMembership.count()).toBe(3);
      expect(
        await tx.workspaceMembership.count({
          where: { role: 'OWNER', status: 'SUSPENDED' },
        }),
      ).toBe(1);
      expect(
        (
          await tx.providerWorkspace.findUniqueOrThrow({
            where: { id: s.w.id },
          })
        ).ownershipRevision,
      ).toBe(1);
    });
  });

  it('keeps concurrent tenants isolated on separate pooled backends', async () => {
    const ids = subjects.slice(4, 6).map((s) => s.w.id);
    const results = await Promise.all(
      ids.map((id) =>
        f.scopedRead(id, async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM pg_sleep(0.05)`;
          return (await tx.providerWorkspace.findMany()).map((w) => w.id);
        }),
      ),
    );
    expect(results).toEqual(ids.map((id) => [id]));
  });

  it('global allocation uniqueness defeats concurrent PERSONAL creation despite tenant-hidden allocations', async () => {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        creation.run(
          creator,
          { kind: 'PERSONAL', displayName: 'Personal' },
          async () => {},
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const result = results.find((r) => r.status === 'fulfilled');
    if (!result || result.status !== 'fulfilled')
      throw new Error('No personal workspace');
    const id = result.value.id;
    await f.scopedRead(id, async (tx) => {
      await f.conversion.withinTransaction(tx, {
        workspaceId: id,
        expectedRevision: 1,
        legalName: 'Converted GmbH',
      });
    });
    await expect(
      creation.run(
        creator,
        { kind: 'PERSONAL', displayName: 'Blocked' },
        async () => {},
      ),
    ).rejects.toBeDefined();
    await f.scopedRead(id, (tx) =>
      f.lifecycle.beginClosingWithinTransaction(tx, id, 2),
    );
    await expect(
      creation.run(
        creator,
        { kind: 'PERSONAL', displayName: 'Still blocked' },
        async () => {},
      ),
    ).rejects.toBeDefined();
    await f.scopedRead(id, (tx) =>
      f.lifecycle.completeClosureWithinTransaction(tx, id, 3),
    );
    await f.scopedRead(id, async (tx) => {
      const allocation =
        await tx.personalWorkspaceAllocation.findFirstOrThrow();
      expect(allocation.releasedAt).not.toBeNull();
      expect(allocation.releaseReason).toBe('WORKSPACE_CLOSED');
    });
    const future = await creation.run(
      creator,
      { kind: 'PERSONAL', displayName: 'New explicit allocation' },
      async () => {},
    );
    expect(future.id).not.toBe(id);
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: creator.userId },
      }),
    ).toBe(2);
  });

  it('PERSONAL permits REMOVED history but rejects a second non-REMOVED membership', async () => {
    const owner = subjects[6].authority;
    const w = await creation.run(
      owner,
      { kind: 'PERSONAL', displayName: 'History' },
      async () => {},
    );
    const memberId = randomUUID();
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color)
        VALUES($1,$2,$3,'AGENT','#123456')`,
        [memberId, w.id, creator.userId],
      );
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [memberId],
      );
    });
    await f.scopedRead(w.id, async (tx) => {
      expect(await tx.workspaceMembership.count()).toBe(2);
      expect(
        await tx.workspaceMembership.count({
          where: { status: { not: 'REMOVED' } },
        }),
      ).toBe(1);
    });
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `UPDATE workspace_memberships SET status='ACTIVE' WHERE id=$1`,
          [memberId],
        );
      }),
    ).rejects.toBeDefined();
  });

  it('two ownership transfers from the same revision cannot both commit', async () => {
    const s = subjects[4];
    const outcomes = await Promise.allSettled(
      s.w.agents.map((target) =>
        f.scopedRead(s.w.id, async (tx) => {
          await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${s.w.id}::uuid,1)`;
          await tx.workspaceMembership.update({
            where: { id: s.w.owner },
            data: { role: 'AGENT' },
          });
          await tx.workspaceMembership.update({
            where: { id: target.id },
            data: { role: 'OWNER' },
          });
        }),
      ),
    );
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: s.w.id },
        })
      ).ownershipRevision,
    ).toBe(2);
  });

  it('Serializable retries reinstall a fresh xid-stamped scope', async () => {
    const ids: string[] = [];
    await f.scopedRead(subjects[5].w.id, async (tx) => {
      const [row] = await tx.$queryRaw<{ stamp: string; current: string }[]>`
        SELECT current_setting('app.tenant_xid') stamp,pg_current_xact_id()::text current`;
      expect(row.stamp).toBe(row.current);
      ids.push(row.stamp);
      expect(await tx.providerWorkspace.count()).toBe(1);
      if (ids.length === 1)
        await tx.$executeRawUnsafe(
          `DO $$ BEGIN RAISE EXCEPTION 'retry proof' USING ERRCODE='40001'; END $$`,
        );
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('transfer participant composite constraints cannot reference a foreign tenant', async () => {
    const s = subjects[5];
    await expect(
      f.scopedRead(s.w.id, (tx) =>
        f.intents.confirmWithinTransaction(tx, {
          ...f.intent(s.w),
          targetMembershipId: subjects[0].membershipId,
        }),
      ),
    ).rejects.toBeDefined();
  });
});
