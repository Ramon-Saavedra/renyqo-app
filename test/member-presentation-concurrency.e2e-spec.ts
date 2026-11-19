import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { sqlTenant } from './workspace-tenant.fixture';
import { isMemberColor } from '../src/member-presentation/member-color.catalog';
jest.setTimeout(60000);
describe('Member color assignment under observed root-lock waits', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  async function waitBlocked(count: number) {
    const until = Date.now() + 5000;
    do {
      const {
        rows: [row],
      } = await f.db.pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1 AND cardinality(pg_blocking_pids(pid))>0`,
        [f.db.applicationLogin],
      );
      if (row.n >= count) return;
    } while (Date.now() < until);
    throw new Error('Expected observed acceptance lock wait');
  }
  it('serializes two distinct acceptances requesting the same currently unused color', async () => {
    const owner = await f.owner(),
      accounts = [await f.account(), await f.account()];
    for (const account of accounts) {
      await f.verify(account);
      await f.invite(owner, account.email, randomUUID(), 'MAGENTA');
    }
    const c = await f.db.runtimePool.connect();
    let pending: Promise<{ status: number }>[] = [];
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(c, f.w.id);
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      pending = accounts.map((a) =>
        a.client
          .post('/api/v1/workspace-invitations/accept')
          .send({
            token: f.secret(a.email, 'invitation'),
            commandId: randomUUID(),
          })
          .then((r) => ({ status: r.status })),
      );
      await waitBlocked(2);
      await c.query('COMMIT');
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([
        200, 200,
      ]);
      const members = await f.db.prisma.workspaceMembership.findMany({
        where: {
          workspaceId: f.w.id,
          userId: { in: accounts.map((a) => a.id) },
        },
      });
      expect(members.map((m) => m.displayColor)).toContain('MAGENTA');
      expect(new Set(members.map((m) => m.displayColor)).size).toBe(2);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await Promise.all(pending);
    }
  });
  it('observes removal before selecting a newly reusable color without modifying historical membership', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const old = await f.db.prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: f.w.agents[0].id },
    });
    if (!isMemberColor(old.displayColor))
      throw new Error('Invalid fixture color');
    await f.invite(owner, account.email, randomUUID(), old.displayColor);
    const c = await f.db.runtimePool.connect();
    let pending: Promise<number> | undefined;
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await sqlTenant(c, f.w.id);
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      pending = account.client
        .post('/api/v1/workspace-invitations/accept')
        .send({
          token: f.secret(account.email, 'invitation'),
          commandId: randomUUID(),
        })
        .then((r) => r.status);
      await waitBlocked(1);
      await c.query(
        `UPDATE workspace_memberships SET status='REMOVED' WHERE id=$1`,
        [old.id],
      );
      await c.query('COMMIT');
      expect(await pending).toBe(200);
      const member = await f.db.prisma.workspaceMembership.findUniqueOrThrow({
        where: {
          workspaceId_userId: { workspaceId: f.w.id, userId: account.id },
        },
      });
      expect(member.displayColor).toBe(old.displayColor);
      expect(
        (
          await f.db.prisma.workspaceMembership.findUniqueOrThrow({
            where: { id: old.id },
          })
        ).displayColor,
      ).toBe(old.displayColor);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await pending;
    }
  });
});
