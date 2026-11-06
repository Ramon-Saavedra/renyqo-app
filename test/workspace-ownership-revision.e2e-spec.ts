import type { PoolClient } from 'pg';
import { WorkspaceFixture } from './provider-workspaces.fixture';

jest.setTimeout(30000);

describe('Database-derived workspace ownership revision', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  async function organization() {
    const input = f.command(await f.user(), 'ORGANIZATION');
    await f.establish(input);
    const agents: string[] = [];
    for (let i = 0; i < 2; i++) {
      const member = await f.prisma.workspaceMembership.create({
        data: {
          workspaceId: input.workspaceId,
          userId: await f.user(),
          role: 'AGENT',
          displayColor: '#7C3AED',
        },
      });
      agents.push(member.id);
    }
    return { id: input.workspaceId, original: input.membershipId, agents };
  }

  function lock(c: PoolClient, id: string, revision = 1) {
    return c.query('SELECT lock_workspace_ownership_revision($1, $2)', [
      id,
      revision,
    ]);
  }

  async function roles(c: PoolClient, id: string, target: string) {
    await c.query(
      `UPDATE workspace_memberships SET role='AGENT' WHERE workspace_id=$1 AND role='OWNER'`,
      [id],
    );
    await c.query(
      `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1 AND workspace_id=$2`,
      [target, id],
    );
  }

  async function state(id: string) {
    const workspace = await f.prisma.providerWorkspace.findUniqueOrThrow({
      where: { id },
    });
    const owners = await f.prisma.workspaceMembership.findMany({
      where: { workspaceId: id, role: 'OWNER' },
    });
    return {
      revision: workspace.ownershipRevision,
      owners: owners.map((m) => m.id),
    };
  }

  it('raw SQL demotion plus promotion advances exactly once and invalidates the old revision', async () => {
    const w = await organization();
    await f.sqlTransaction(async (c) => {
      await lock(c, w.id);
      await roles(c, w.id, w.agents[0]);
    });
    expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[0]] });
    await expect(
      f.sqlTransaction(async (c) => {
        await lock(c, w.id, 1);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[0]] });
  });

  it('derives one net increment even with multiple role changes in the same transaction', async () => {
    const w = await organization();
    await f.sqlTransaction(async (c) => {
      await lock(c, w.id);
      await roles(c, w.id, w.agents[0]);
      await roles(c, w.id, w.agents[1]);
    });
    expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[1]] });
  });

  it('does not advance when the final OWNER is unchanged', async () => {
    const w = await organization();
    await f.sqlTransaction(async (c) => {
      await lock(c, w.id);
      await roles(c, w.id, w.agents[0]);
      await roles(c, w.id, w.original);
    });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('keeps the original baseline across forced deferred-check flushes', async () => {
    const w = await organization();
    await f.sqlTransaction(async (c) => {
      await lock(c, w.id);
      await roles(c, w.id, w.agents[0]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const projected = await c.query<{ ownership_revision: number }>(
        'SELECT ownership_revision FROM provider_workspaces WHERE id=$1',
        [w.id],
      );
      expect(projected.rows[0].ownership_revision).toBe(2);
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await roles(c, w.id, w.original);
    });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('does not advance for AGENT insertion or non-owner membership updates', async () => {
    const w = await organization();
    await f.sqlTransaction(async (c) => {
      await lock(c, w.id);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [w.agents[0]],
      );
    });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('does not advance for profile edits, conversion, allocation creation or closure release', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await f.tx((tx) =>
      f.conversion.withinTransaction(tx, {
        workspaceId: input.workspaceId,
        expectedRevision: 1,
        legalName: 'Agency',
      }),
    );
    await f.sqlTransaction(async (c) => {
      await lock(c, input.workspaceId);
      await c.query(
        `UPDATE organization_profiles SET legal_name='Changed Agency', revision=revision+1 WHERE workspace_id=$1`,
        [input.workspaceId],
      );
    });
    expect(await state(input.workspaceId)).toEqual({
      revision: 1,
      owners: [input.membershipId],
    });
    await f.close(input.workspaceId, 2);
    expect(await state(input.workspaceId)).toEqual({
      revision: 1,
      owners: [input.membershipId],
    });
    expect(
      await f.prisma.personalWorkspaceAllocation.findFirst({
        where: { workspaceId: input.workspaceId },
      }),
    ).toMatchObject({ releaseReason: 'WORKSPACE_CLOSED' });
  });

  it('rolls back role and revision changes after an early flush and later failure', async () => {
    const w = await organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await lock(c, w.id);
        await roles(c, w.id, w.agents[0]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        throw new Error('Later transaction failure');
      }),
    ).rejects.toThrow('Later transaction failure');
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('rejects an ownerless commit without advancing the revision', async () => {
    const w = await organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await lock(c, w.id);
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
          [w.original],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('allows only one competing change from the same expected ownership revision', async () => {
    const w = await organization();
    const results = await Promise.allSettled(
      w.agents.map((target) =>
        f.sqlTransaction(async (c) => {
          await lock(c, w.id, 1);
          await roles(c, w.id, target);
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const result = await state(w.id);
    expect(result.revision).toBe(2);
    expect(result.owners).toHaveLength(1);
  });

  it('rejects a stale Repeatable Read snapshot instead of accepting a second change', async () => {
    const w = await organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await c.query(
          'SELECT ownership_revision FROM provider_workspaces WHERE id=$1',
          [w.id],
        );
        await f.sqlTransaction(async (other) => {
          await lock(other, w.id);
          await roles(other, w.id, w.agents[0]);
        });
        await lock(c, w.id, 1);
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[0]] });
  });

  it('rejects manual counter increments, decrements and baseline tampering through raw SQL', async () => {
    const w = await organization();
    for (const delta of [1, 2, -1]) {
      await expect(
        f.pool.query(
          'UPDATE provider_workspaces SET ownership_revision=ownership_revision+$2, revision=revision+1 WHERE id=$1',
          [w.id, delta],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      f.pool.query(
        'UPDATE workspace_ownership_revision_baselines SET transaction_id=pg_current_xact_id()::text WHERE workspace_id=$1',
        [w.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      f.pool.query(
        'DELETE FROM workspace_ownership_revision_baselines WHERE workspace_id=$1',
        [w.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('rejects child-first role writes before waiting for a parent lock', async () => {
    const w = await organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query(
          `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
          [w.original],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('does not accept an unrelated parent write as an ownership revision assertion', async () => {
    const w = await organization();
    await expect(
      f.sqlTransaction(async (c) => {
        await c.query(
          'UPDATE provider_workspaces SET revision=revision WHERE id=$1',
          [w.id],
        );
        await roles(c, w.id, w.agents[0]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await state(w.id)).toEqual({ revision: 1, owners: [w.original] });
  });

  it('fails a child-first writer without waiting on a parent held by the valid writer', async () => {
    const w = await organization();
    const parent = await f.pool.connect();
    try {
      await parent.query('BEGIN');
      await lock(parent, w.id);
      await expect(
        f.sqlTransaction(async (child) => {
          await child.query(`SET LOCAL lock_timeout='300ms'`);
          await child.query(
            `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
            [w.original],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
      await roles(parent, w.id, w.agents[0]);
      await parent.query('COMMIT');
    } catch (error) {
      await parent.query('ROLLBACK');
      throw error;
    } finally {
      parent.release();
    }
    expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[0]] });
  });
  it('does not depend on root assertion trigger name ordering', async () => {
    const w = await organization();
    await f.pool.query(
      'ALTER TRIGGER workspace_ownership_revision_assertion ON provider_workspaces RENAME TO aaa_revision_assertion',
    );
    try {
      await f.sqlTransaction(async (c) => {
        await lock(c, w.id);
        await roles(c, w.id, w.agents[0]);
      });
      expect(await state(w.id)).toEqual({ revision: 2, owners: [w.agents[0]] });
    } finally {
      await f.pool.query(
        'ALTER TRIGGER aaa_revision_assertion ON provider_workspaces RENAME TO workspace_ownership_revision_assertion',
      );
    }
  });
});
