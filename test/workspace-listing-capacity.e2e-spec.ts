import { randomUUID } from 'node:crypto';
import { CapacityFixture } from './workspace-capacity.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
jest.setTimeout(60000);
describe('Database listing capacity through restricted login', () => {
  const f = new CapacityFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  it('enforces the final slot, including raw runtime writes', async () => {
    const w = await f.assigned();
    await f.create(w);
    await expect(f.create(w)).rejects.toMatchObject({
      code: '23514',
      constraint: 'LISTING_LIMIT_REACHED',
    });
  });
  it('rejects a multi-row acquisition and rolls back every row', async () => {
    const w = await f.assigned();
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `INSERT INTO listings(id,workspace_id,created_by_membership_id,responsible_membership_id,display_order,photos) VALUES($1,$3,$4,$4,1,ARRAY[]::text[]),($2,$3,$4,$4,2,ARRAY[]::text[])`,
          [randomUUID(), randomUUID(), w.id, w.owner],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'LISTING_LIMIT_REACHED' });
    expect(await f.prisma.listing.count({ where: { workspaceId: w.id } })).toBe(
      0,
    );
  });
  it('serializes two final-slot contenders without sleeps', async () => {
    const w = await f.assigned();
    const a = await f.runtimePool.connect(),
      b = await f.runtimePool.connect();
    try {
      await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(a, w.id);
      await a.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(b, w.id);
      const blocked = b
        .query('SELECT lock_workspace_ownership_revision($1,1)', [w.id])
        .then(
          () => ({ ok: true }),
          (error) => ({ error: error as { code: string } }),
        );
      await f.insert(a, w);
      await a.query('COMMIT');
      expect(await blocked).toMatchObject({ error: { code: '40001' } });
      await b.query('ROLLBACK');
      await expect(f.create(w)).rejects.toMatchObject({
        constraint: 'LISTING_LIMIT_REACHED',
      });
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });
  it('retirement releases exactly one slot and relisting preserves immutable lineage', async () => {
    const w = await f.assigned();
    const old = await f.create(w);
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(`UPDATE listings SET status='retired' WHERE id=$1`, [old]);
    });
    const successor = await f.create(w, old);
    expect(
      (await f.prisma.listing.findUniqueOrThrow({ where: { id: successor } }))
        .predecessorListingId,
    ).toBe(old);
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `UPDATE listings SET status='draft',display_order=3,retired_at=NULL WHERE id=$1`,
          [old],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(f.create(w)).rejects.toMatchObject({
      constraint: 'LISTING_LIMIT_REACHED',
    });
  });
  it('allows forced over-limit, blocks growth and voluntary downgrade, preserves reductions', async () => {
    const w = await f.assigned(2);
    const old = await f.create(w);
    await f.create(w);
    const lower = await f.plan(1);
    await expect(f.change(w.id, w.owner, lower)).rejects.toMatchObject({
      constraint: 'DOWNGRADE_BLOCKED',
    });
    await f.change(w.id, w.owner, lower, 'FORCED');
    expect(await f.prisma.listing.count({ where: { workspaceId: w.id } })).toBe(
      2,
    );
    await expect(f.create(w)).rejects.toMatchObject({
      constraint: 'LISTING_LIMIT_REACHED',
    });
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(`UPDATE listings SET status='retired' WHERE id=$1`, [old]);
    });
    await f.change(w.id, w.owner, await f.plan(3));
    await f.create(w);
  });
  it('denies context-free/foreign reads and catalog mutation', async () => {
    const w = await f.assigned();
    expect(
      (await f.runtimePool.query('SELECT * FROM workspace_plan_assignments'))
        .rows,
    ).toEqual([]);
    await expect(
      f.runtimePool.query('UPDATE plan_versions SET max_listings=999'),
    ).rejects.toMatchObject({ code: '42501' });
    const other = await f.assigned();
    expect(
      await f.runtimeSql(
        other.id,
        async (c) =>
          (
            await c.query(
              'SELECT * FROM workspace_plan_assignments WHERE workspace_id=$1',
              [w.id],
            )
          ).rowCount,
      ),
    ).toBe(0);
  });
});
