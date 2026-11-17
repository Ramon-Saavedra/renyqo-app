import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { randomUUID } from 'node:crypto';
import { CapacityFixture } from './workspace-capacity.fixture';
jest.setTimeout(60000);
describe('Seat capacity and immutable product terms', () => {
  const f = new CapacityFixture();
  beforeAll(async () => {
    await f.start();
    await f.activateApplication();
  });
  afterAll(() => f.stop());
  async function reserve(w: { id: string }, id = randomUUID()) {
    return f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,expires_at) VALUES($1,$2,$1,clock_timestamp()+interval '1 hour')`,
        [id, w.id],
      );
      return id;
    });
  }
  it('counts OWNER once, reserves the last seat, and releases idempotently', async () => {
    const w = await f.assigned(3, 2);
    const id = await reserve(w);
    await expect(reserve(w)).rejects.toMatchObject({
      constraint: 'SEAT_LIMIT_REACHED',
    });
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        'UPDATE workspace_seat_reservations SET released_at=clock_timestamp() WHERE id=$1',
        [id],
      );
      await c.query(
        'UPDATE workspace_seat_reservations SET released_at=released_at WHERE id=$1',
        [id],
      );
    });
    await reserve(w);
  });
  it('suspension retains occupancy and removal releases it without deleting history', async () => {
    const w = await f.assigned(2, 2);
    const member = randomUUID(),
      user = await f.user();
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,status,display_color) VALUES($1,$2,$3,'AGENT','ACTIVE','#123456')`,
        [member, w.id, user],
      );
    });
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
        [member],
      );
    });
    await expect(reserve(w)).rejects.toMatchObject({
      constraint: 'SEAT_LIMIT_REACHED',
    });
    await f.runtimeSql(w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [member],
      );
    });
    await reserve(w);
    expect(
      (
        await f.prisma.workspaceMembership.findUniqueOrThrow({
          where: { id: member },
        })
      ).status,
    ).toBe('REMOVED');
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `UPDATE workspace_memberships SET status='ACTIVE' WHERE id=$1`,
          [member],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'SEAT_LIMIT_REACHED' });
  });
  it('has one final-seat winner among concurrent reservations', async () => {
    const w = await f.assigned(2, 2);
    const outcomes = await Promise.allSettled([reserve(w), reserve(w)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await f.prisma.workspaceSeatReservation.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(1);
  });
  it('rejects expired reservations and rollback leaves no capacity evidence', async () => {
    const w = await f.assigned(2, 2);
    await expect(
      f.runtimeSql(w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [w.id]);
        await c.query(
          `INSERT INTO workspace_seat_reservations(id,workspace_id,command_id,created_at,expires_at) VALUES($1,$2,$1,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,
          [randomUUID(), w.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await f.prisma.workspaceSeatReservation.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(0);
  });
  it('keeps published versions immutable and assignment history durable', async () => {
    const w = await f.assigned();
    const history = await f.prisma.workspacePlanChange.count({
      where: { workspaceId: w.id },
    });
    await expect(
      f.pool.query('UPDATE plan_versions SET max_listings=10 WHERE id=$1', [
        w.plan,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await f.change(w.id, w.owner, await f.plan(3));
    expect(
      await f.prisma.workspacePlanChange.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(history + 1);
    await expect(
      f.runtimeSql(w.id, (c) =>
        c.query('DELETE FROM workspace_plan_changes WHERE workspace_id=$1', [
          w.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('unassigned organizations retain their OWNER but cannot grow', async () => {
    const w = await f.assigned();
    await f.change(w.id, w.owner, null, 'FORCED');
    await expect(f.create(w)).rejects.toMatchObject({
      constraint: 'PLAN_UNAVAILABLE',
    });
    await expect(reserve(w)).rejects.toMatchObject({
      constraint: 'PLAN_UNAVAILABLE',
    });
    expect(
      await f.prisma.workspaceMembership.count({
        where: { workspaceId: w.id },
      }),
    ).toBe(1);
  });
  it('PERSONAL structural ceiling survives an oversized plan and prohibits reservations', async () => {
    const user = await f.user(),
      input = f.command(user, 'PERSONAL');
    await f.tx(async (tx) => {
      await installTenantContext(tx, input.workspaceId);
      await f.establishment.withinTransaction(tx, input);
    });
    const plan = randomUUID();
    await f.pool.query(
      `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats) VALUES($1::uuid,$1::text,1,'PERSONAL',9,9)`,
      [plan],
    );
    await f.change(input.workspaceId, input.membershipId, plan);
    const w = { id: input.workspaceId, owner: input.membershipId };
    await f.create(w);
    await expect(f.create(w)).rejects.toMatchObject({
      constraint: 'personal_capacity',
    });
    await expect(reserve(w)).rejects.toMatchObject({ code: '23514' });
  });
});
