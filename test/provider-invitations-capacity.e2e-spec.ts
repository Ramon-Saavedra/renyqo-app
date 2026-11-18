import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
jest.setTimeout(60000);
describe('Invitation capacity exchange and rollback', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  async function plan(seats: number | null) {
    const id = seats === null ? null : randomUUID();
    if (id)
      await f.db.pool.query(
        `INSERT INTO plan_versions(id,plan_key,version,workspace_kind,max_listings,max_seats) VALUES($1::uuid,$1::text,1,'ORGANIZATION',100,$2)`,
        [id, seats],
      );
    await f.db.runtimeSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        `UPDATE workspace_plan_assignments SET plan_version_id=$2,source='INTERNAL',change_mode='FORCED',command_id=$3,actor_membership_id=$4 WHERE workspace_id=$1`,
        [f.w.id, id, randomUUID(), f.w.owner],
      );
    });
  }
  it('exchanges the last reserved seat without temporary double counting', async () => {
    const used = await f.db.prisma.workspaceMembership.count({
      where: { workspaceId: f.w.id, status: { not: 'REMOVED' } },
    });
    await plan(used + 1);
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({
        token: f.secret(account.email, 'invitation'),
        commandId: randomUUID(),
      })
      .expect(200);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id },
      }),
    ).toBe(used + 1);
    await owner
      .post('/api/v1/provider/workspace-invitations')
      .set('x-workspace-id', f.w.id)
      .send({ email: `${randomUUID()}@invite.test`, commandId: randomUUID() })
      .expect(409);
  });
  it('a reserved seat cannot override a forced OVER_LIMIT downgrade or unassigned plan', async () => {
    await plan(100);
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation');
    for (const seats of [1, null]) {
      await plan(seats);
      await account.client
        .post('/api/v1/workspace-invitations/accept')
        .send({ token, commandId: randomUUID() })
        .expect(409);
      expect(
        await f.db.prisma.workspaceMembership.count({
          where: { workspaceId: f.w.id, userId: account.id },
        }),
      ).toBe(0);
      const row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: body.id },
        include: { reservation: true },
      });
      expect(row.status).toBe('PENDING');
      expect(row.reservation.releasedAt).toBeNull();
    }
    await plan(100);
  });
  it('rollback restores invitation, reservation and absence of membership/evidence together', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: body.id },
      }),
      command = randomUUID();
    await expect(
      f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query('SELECT admit_workspace_invitation($1,$2,$3,$4,$5)', [
          row.id,
          account.id,
          row.tokenHash,
          command,
          randomUUID(),
        ]);
        throw new Error('Intentional outer transaction rollback');
      }),
    ).rejects.toThrow('Intentional outer transaction rollback');
    expect(
      (
        await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).status,
    ).toBe('PENDING');
    expect(
      (
        await f.db.prisma.workspaceSeatReservation.findUniqueOrThrow({
          where: { id: row.reservationId },
        })
      ).releasedAt,
    ).toBeNull();
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: account.id },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.workspaceInvitationCommand.count({
        where: { workspaceId: f.w.id, commandId: command },
      }),
    ).toBe(0);
  });
});
