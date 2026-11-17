import { randomUUID } from 'node:crypto';
import { CapacityFixture } from './workspace-capacity.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
jest.setTimeout(60000);
describe('Plan and capacity root-lock ordering', () => {
  const f = new CapacityFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('creation wins before a competing downgrade; retry validates actual usage', async () => {
    const w = await f.assigned(2),
      lower = await f.plan(1);
    await f.create(w);
    const a = await f.runtimePool.connect(),
      b = await f.runtimePool.connect();
    try {
      await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(a, w.id);
      await a.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(b, w.id);
      const pending = b
        .query('SELECT lock_workspace_ownership_revision($1,1)', [w.id])
        .then(
          () => null,
          (error) => error as { code: string },
        );
      await f.insert(a, w);
      await a.query('COMMIT');
      expect(await pending).toMatchObject({ code: '40001' });
      await b.query('ROLLBACK');
      await expect(f.change(w.id, w.owner, lower)).rejects.toMatchObject({
        constraint: 'DOWNGRADE_BLOCKED',
      });
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });
  it('a committed lower seat plan is authoritative for subsequent reservation acquisition', async () => {
    const w = await f.assigned(2, 2);
    await f.change(w.id, w.owner, await f.plan(2, 1));
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 hour')`,
          [randomUUID(), w.id],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'SEAT_LIMIT_REACHED' });
  });
  it('rejects stale reservation expiry after an observed root-lock wait', async () => {
    const w = await f.assigned(2, 2),
      a = await f.runtimePool.connect(),
      b = await f.runtimePool.connect();
    try {
      await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(a, w.id);
      await a.query(
        'SELECT id FROM provider_workspaces WHERE id=$1 FOR UPDATE',
        [w.id],
      );
      await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(b, w.id);
      const pid = (
        await b.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const expiry = (
        await a.query<{ expiry: Date }>(
          `SELECT clock_timestamp()-interval '1 second' expiry`,
        )
      ).rows[0].expiry;
      const pending = b.query(
        'SELECT lock_workspace_ownership_revision($1,1)',
        [w.id],
      );
      let blocked = false;
      const until = Date.now() + 2000;
      while (!blocked && Date.now() < until)
        blocked = (
          await f.pool.query<{ blocked: boolean }>(
            'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
            [pid],
          )
        ).rows[0].blocked;
      expect(blocked).toBe(true);
      await a.query('COMMIT');
      await pending;
      await expect(
        b.query(
          `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,created_at,expires_at) VALUES($1,$2,$1,$3::timestamptz-interval '1 hour',$3)`,
          [randomUUID(), w.id, expiry],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });
});
