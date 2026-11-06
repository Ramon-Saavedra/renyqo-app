import { randomUUID } from 'node:crypto';
import { MembershipFixture } from './provider-memberships.fixture';
import { ownershipTransition } from '../src/provider-memberships/domain/ownership-transition.policy';

jest.setTimeout(30000);
describe('PostgreSQL membership lifecycle', () => {
  const f = new MembershipFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  it('establishes ACTIVE revision one with unchanged identity timestamps', async () => {
    const w = await f.organization();
    const m = await f.member(w.owner);
    expect(m.status).toBe('ACTIVE');
    expect(m.revision).toBe(1);
    expect(m.updatedAt).toEqual(m.createdAt);
  });

  it('suspends/resumes without changing global identity or canonical ownership', async () => {
    const w = await f.organization();
    const before = await f.prisma.user.findUniqueOrThrow({
      where: { id: w.ownerUser },
    });
    await f.change(w.id, w.owner, 'SUSPENDED');
    expect(await f.member(w.owner)).toMatchObject({
      role: 'OWNER',
      status: 'SUSPENDED',
      revision: 2,
    });
    await f.change(w.id, w.owner, 'ACTIVE');
    expect(await f.member(w.owner)).toMatchObject({
      role: 'OWNER',
      status: 'ACTIVE',
      revision: 3,
    });
    expect(
      await f.prisma.user.findUniqueOrThrow({ where: { id: w.ownerUser } }),
    ).toEqual(before);
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: w.id },
      }),
    ).toMatchObject({ ownershipRevision: 1 });
  });

  it.each(['ACTIVE', 'SUSPENDED'] as const)(
    'removes %s AGENT and reinstates the same row as ACTIVE AGENT',
    async (from) => {
      const w = await f.organization();
      const m = w.agents[0];
      if (from === 'SUSPENDED') await f.change(w.id, m.id, from);
      await f.change(w.id, m.id, 'REMOVED');
      const removed = await f.member(m.id);
      await f.change(w.id, m.id, 'ACTIVE');
      expect(await f.member(m.id)).toMatchObject({
        id: m.id,
        role: 'AGENT',
        status: 'ACTIVE',
        displayColor: m.displayColor,
        createdAt: m.createdAt,
        revision: removed.revision + 1,
      });
    },
  );

  it('rejects REMOVED to SUSPENDED and direct removed establishment', async () => {
    const w = await f.organization();
    await f.change(w.id, w.agents[0].id, 'REMOVED');
    await expect(
      f.change(w.id, w.agents[0].id, 'SUSPENDED'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.pool.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,status,display_color) VALUES ($1,$2,$3,'AGENT','REMOVED','#123456')`,
        [randomUUID(), w.id, await f.user()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects ACTIVE and SUSPENDED OWNER removal', async () => {
    const w = await f.organization();
    await expect(f.change(w.id, w.owner, 'REMOVED')).rejects.toMatchObject({
      code: '23514',
    });
    await f.change(w.id, w.owner, 'SUSPENDED');
    await expect(f.change(w.id, w.owner, 'REMOVED')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('ignores no-op status/timestamp writes but rejects revision tampering', async () => {
    const w = await f.organization();
    const m = w.agents[0];
    await f.sqlTransaction(async (c) => {
      await f.lock(c, w.id);
      await c.query(
        `UPDATE workspace_memberships SET status=status, updated_at='2000-01-01' WHERE id=$1`,
        [m.id],
      );
    });
    expect(await f.member(m.id)).toEqual(m);
    for (const value of [0, 2, 10]) {
      await expect(
        f.sqlTransaction(async (c) => {
          await f.lock(c, w.id);
          await c.query(
            'UPDATE workspace_memberships SET revision=$2 WHERE id=$1',
            [m.id, value],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it.each(['DEMOTE_TO_AGENT', 'REMOVE_MEMBERSHIP'] as const)(
    '%s structural transfer changes each membership once and ownership once',
    async (outcome) => {
      const w = await f.organization();
      const plan = ownershipTransition(outcome);
      await f.sqlTransaction(async (c) => {
        await f.lock(c, w.id);
        await c.query(
          `SELECT id FROM workspace_memberships WHERE workspace_id=$1 ORDER BY id FOR UPDATE`,
          [w.id],
        );
        await c.query(
          `UPDATE workspace_memberships SET role=$2::"WorkspaceMembershipRole",status=$3::"WorkspaceMembershipStatus" WHERE id=$1`,
          [w.owner, plan.formerOwner.role, plan.formerOwner.status],
        );
        await c.query(
          `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
          [w.agents[0].id],
        );
      });
      expect(await f.member(w.owner)).toMatchObject({
        ...plan.formerOwner,
        revision: 2,
      });
      expect(await f.member(w.agents[0].id)).toMatchObject({
        ...plan.target,
        revision: 2,
      });
      expect(
        await f.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: w.id },
        }),
      ).toMatchObject({ ownershipRevision: 2 });
      if (outcome === 'REMOVE_MEMBERSHIP') {
        await expect(
          f.sqlTransaction(async (c) => {
            await f.lock(c, w.id, 2);
            await c.query(
              `UPDATE workspace_memberships SET status='ACTIVE',role='OWNER' WHERE id=$1`,
              [w.owner],
            );
          }),
        ).rejects.toMatchObject({ code: '23514' });
        await f.sqlTransaction(async (c) => {
          await f.lock(c, w.id, 2);
          await c.query(
            `UPDATE workspace_memberships SET status='ACTIVE' WHERE id=$1`,
            [w.owner],
          );
        });
        expect(await f.member(w.owner)).toMatchObject({
          role: 'AGENT',
          status: 'ACTIVE',
          revision: 3,
        });
      }
    },
  );

  it('membership revision remains monotonic after returning to original role', async () => {
    const w = await f.organization();
    await f.sqlTransaction(async (c) => {
      await f.lock(c, w.id);
      for (const target of [w.agents[0].id, w.owner]) {
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT' WHERE workspace_id=$1 AND role='OWNER'`,
          [w.id],
        );
        await c.query(
          `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
          [target],
        );
      }
    });
    expect(await f.member(w.owner)).toMatchObject({
      role: 'OWNER',
      revision: 3,
    });
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: w.id },
      }),
    ).toMatchObject({ ownershipRevision: 1 });
  });

  it('PERSONAL retains removed history, rejects a second non-REMOVED member and rejects reinstatement into a team', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    const id = randomUUID();
    const userId = await f.user();
    await f.sqlTransaction(async (c) => {
      await f.lock(c, input.workspaceId);
      await c.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES ($1,$2,$3,'AGENT','#123456')`,
        [id, input.workspaceId, userId],
      );
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [id],
      );
    });
    expect(await f.member(id)).toMatchObject({
      status: 'REMOVED',
      revision: 2,
    });
    await expect(
      f.change(input.workspaceId, id, 'ACTIVE'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.prisma.workspaceMembership.create({
        data: {
          workspaceId: input.workspaceId,
          userId: await f.user(),
          role: 'AGENT',
          displayColor: '#123456',
        },
      }),
    ).rejects.toBeDefined();
  });

  it('preserves durable uniqueness, immutable identity/color and rejects physical deletion', async () => {
    const w = await f.organization();
    const m = w.agents[0];
    await f.change(w.id, m.id, 'REMOVED');
    for (const assignment of [
      `display_color='#FFFFFF'`,
      `created_at=created_at+interval '1 day'`,
      `id='${randomUUID()}'`,
      `user_id='${await f.user()}'`,
      `workspace_id='${randomUUID()}'`,
    ]) {
      await expect(
        f.sqlTransaction(async (c) => {
          await f.lock(c, w.id);
          await c.query(
            `UPDATE workspace_memberships SET ${assignment} WHERE id=$1`,
            [m.id],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      f.pool.query('DELETE FROM workspace_memberships WHERE id=$1', [m.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.prisma.workspaceMembership.create({
        data: {
          workspaceId: w.id,
          userId: m.userId,
          role: 'AGENT',
          displayColor: m.displayColor,
        },
      }),
    ).rejects.toBeDefined();
  });

  it('failed ownerless transfer rolls back membership and ownership revisions', async () => {
    const w = await f.organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await f.lock(c, w.id);
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT',status='REMOVED' WHERE id=$1`,
          [w.owner],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.member(w.owner)).toMatchObject({
      role: 'OWNER',
      status: 'ACTIVE',
      revision: 1,
    });
    expect(
      await f.prisma.providerWorkspace.findUniqueOrThrow({
        where: { id: w.id },
      }),
    ).toMatchObject({ ownershipRevision: 1 });
  });

  it('competing suspension calls with one expected membership revision have one winner', async () => {
    const w = await f.organization();
    const m = w.agents[0];
    const input = {
      workspaceId: w.id,
      membershipId: m.id,
      expectedMembershipRevision: 1,
      expectedOwnershipRevision: 1,
    };
    const results = await Promise.allSettled(
      [true, true].map((flag) =>
        f.tx((tx) =>
          f.membershipLifecycle.setSuspendedWithinTransaction(tx, input, flag),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await f.member(m.id)).toMatchObject({
      status: 'SUSPENDED',
      revision: 2,
    });
    // A retry using the new revision is a no-op, rather than another epoch.
    await f.tx((tx) =>
      f.membershipLifecycle.setSuspendedWithinTransaction(
        tx,
        { ...input, expectedMembershipRevision: 2 },
        true,
      ),
    );
    expect((await f.member(m.id)).revision).toBe(2);
  });

  it('competing removal/suspension CAS and stale reinstatement cannot overwrite a newer state', async () => {
    const w = await f.organization();
    const m = w.agents[0];
    const results = await Promise.allSettled(
      ['REMOVED', 'SUSPENDED'].map((status) =>
        f.sqlTransaction(async (c) => {
          await f.lock(c, w.id);
          const result = await c.query(
            'UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1 AND revision=1 RETURNING id',
            [m.id, status],
          );
          if (result.rowCount !== 1)
            throw new Error('Stale membership revision');
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await f.sqlTransaction(async (c) => {
      await f.lock(c, w.id);
      expect(
        (
          await c.query(
            `UPDATE workspace_memberships SET status='ACTIVE' WHERE id=$1 AND revision=1 RETURNING id`,
            [m.id],
          )
        ).rowCount,
      ).toBe(0);
    });
    expect((await f.member(m.id)).revision).toBe(2);
  });

  it('role promotion vs suspension with the same membership revision has one winner', async () => {
    const w = await f.organization();
    const target = w.agents[0];
    const results = await Promise.allSettled([
      f.sqlTransaction(async (c) => {
        await f.lock(c, w.id);
        const m = await c.query<{ revision: number }>(
          'SELECT revision FROM workspace_memberships WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        if (m.rows[0].revision !== 1)
          throw new Error('Stale membership revision');
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
          [w.owner],
        );
        await c.query(
          `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1 AND revision=1`,
          [target.id],
        );
      }),
      f.sqlTransaction(async (c) => {
        await f.lock(c, w.id);
        const result = await c.query(
          `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1 AND revision=1 RETURNING id`,
          [target.id],
        );
        if (result.rowCount !== 1) throw new Error('Stale membership revision');
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.member(target.id)).revision).toBe(2);
    expect(
      await f.prisma.workspaceMembership.count({
        where: { workspaceId: w.id, role: 'OWNER' },
      }),
    ).toBe(1);
  });

  it('rejects child-first status changes immediately while parent is held', async () => {
    const w = await f.organization();
    const c = await f.pool.connect();
    try {
      await c.query('BEGIN');
      await f.lock(c, w.id);
      await expect(
        f.sqlTransaction(async (other) => {
          await other.query(`SET LOCAL lock_timeout='300ms'`);
          await other.query(
            `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
            [w.agents[0].id],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
