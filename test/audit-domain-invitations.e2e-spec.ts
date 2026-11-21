import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { failAudit } from './audit-domain-failure.fixture';

jest.setTimeout(60000);
describe('Required invitation audit through real restricted HTTP boundary', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  const events = (commandId: string) =>
    f.db.prisma.auditEvent.findMany({
      where: { workspaceId: f.w.id, commandId },
      include: { actorIdentity: true },
      orderBy: { action: 'asc' },
    });
  it('records create, rotation, revocation and no duplicate receipt replay without secrets', async () => {
    const owner = await f.owner(),
      account = await f.account();
    const create = randomUUID();
    const row = await f.invite(owner, account.email, create);
    await f.invite(owner, account.email, create);
    expect(await events(create)).toHaveLength(1);
    expect((await events(create))[0]).toMatchObject({
      action: 'provider.invitation.created',
      actorKind: 'MEMBER',
      actorMembershipId: f.w.owner,
      resourceId: row.body.id,
      changes: {
        statusBefore: null,
        statusAfter: 'PENDING',
        revisionBefore: null,
        revisionAfter: 1,
      },
    });
    const resend = randomUUID();
    const rotated = await owner
      .post(`/api/v1/provider/workspace-invitations/${row.body.id}/resend`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: row.body.revision, commandId: resend })
      .expect(201);
    expect((await events(resend))[0]).toMatchObject({
      action: 'provider.invitation.resent',
      changes: {
        statusBefore: 'PENDING',
        statusAfter: 'PENDING',
        revisionBefore: 1,
        revisionAfter: 2,
      },
    });
    const revoke = randomUUID();
    await owner
      .post(`/api/v1/provider/workspace-invitations/${row.body.id}/revoke`)
      .set('x-workspace-id', f.w.id)
      .send({
        revision: (rotated.body as { revision: number }).revision,
        commandId: revoke,
      })
      .expect(201);
    expect((await events(revoke))[0].action).toBe(
      'provider.invitation.revoked',
    );
    const terminal = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: row.body.id },
      }),
      noOp = randomUUID();
    await owner
      .post(`/api/v1/provider/workspace-invitations/${row.body.id}/revoke`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: terminal.revision, commandId: noOp })
      .expect(201);
    expect(await events(noOp)).toHaveLength(0);
    const secret = f.secret(account.email, 'invitation');
    const stored = JSON.stringify(
      await f.db.prisma.auditEvent.findMany({
        where: { workspaceId: f.w.id },
        include: { actorIdentity: true },
      }),
    );
    expect(stored).not.toContain(account.email);
    expect(stored).not.toContain(secret);
    const invitation = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: row.body.id },
    });
    expect(stored).not.toContain(invitation.tokenHash);
  });
  it('records acceptance and membership creation as USER atomically, never duplicates on replay', async () => {
    const owner = await f.owner(),
      a = await f.account();
    await f.verify(a);
    const invite = await f.invite(owner, a.email);
    const token = f.secret(a.email, 'invitation'),
      commandId = randomUUID();
    const accepted = await a.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId })
      .expect(200);
    await a.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId })
      .expect(200);
    await a.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(200);
    const rows = await events(commandId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action)).toEqual([
      'provider.invitation.accepted',
      'provider.membership.created',
    ]);
    for (const r of rows)
      expect(r).toMatchObject({
        actorKind: 'USER',
        actorUserId: a.id,
        actorMembershipId: null,
      });
    expect(rows[0].resourceId).toBe(invite.body.id);
    expect(rows[1].resourceId).toBe((accepted.body as { id: string }).id);
    expect(rows[0].actorIdentityId).toBe(rows[1].actorIdentityId);
  });
  it('rolls back invitation, reservation and receipt on actual audit persistence failure', async () => {
    const owner = await f.owner(),
      email = `${randomUUID()}@failure.test`,
      commandId = randomUUID();
    await failAudit(f.db.pool, async () => {
      const response = await owner
        .post('/api/v1/provider/workspace-invitations')
        .set('x-workspace-id', f.w.id)
        .send({ email, commandId });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect(
      await f.db.prisma.workspaceInvitation.count({ where: { email } }),
    ).toBe(0);
    expect(
      await f.db.prisma.workspaceInvitationCommand.count({
        where: { commandId },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.workspaceSeatReservation.count({
        where: { commandId },
      }),
    ).toBe(0);
    expect(await events(commandId)).toHaveLength(0);
  });
  it('rolls back admission and seat exchange when its required audit fails', async () => {
    const owner = await f.owner(),
      a = await f.account();
    await f.verify(a);
    const i = await f.invite(owner, a.email),
      token = f.secret(a.email, 'invitation'),
      commandId = randomUUID();
    await failAudit(f.db.pool, async () => {
      const response = await a.client
        .post('/api/v1/workspace-invitations/accept')
        .send({ token, commandId });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: a.id },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
        where: { id: i.body.id },
      }),
    ).toMatchObject({ status: 'PENDING', acceptedMembershipId: null });
    expect(
      await f.db.prisma.workspaceInvitationCommand.count({
        where: { commandId },
      }),
    ).toBe(0);
    expect(await events(commandId)).toHaveLength(0);
  });
  it('concurrent admission commits one new membership and exactly two facts', async () => {
    const owner = await f.owner(),
      a = await f.account();
    await f.verify(a);
    await f.invite(owner, a.email);
    const token = f.secret(a.email, 'invitation'),
      commandId = randomUUID();
    const results = await Promise.all(
      [0, 1].map(() =>
        a.client
          .post('/api/v1/workspace-invitations/accept')
          .send({ token, commandId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await events(commandId)).toHaveLength(2);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: a.id },
      }),
    ).toBe(1);
  });
});
