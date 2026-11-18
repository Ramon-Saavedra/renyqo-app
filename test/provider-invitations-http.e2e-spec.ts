import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
jest.setTimeout(60000);
describe('Verified workspace invitation HTTP admission', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('keeps verification independent, exchanges one reserved seat and safely replays', async () => {
    const owner = await f.owner(),
      account = await f.account();
    const invite = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation');
    expect(invite.body).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(invite.body)).not.toContain(token);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(409);
    const proof = await f.verify(account);
    await account.client
      .post('/api/v1/auth/email-verification/confirm')
      .send({ token: proof })
      .expect(400);
    const commandId = randomUUID();
    const accepted = await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId })
      .expect(200);
    const replay = await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId })
      .expect(200);
    expect(replay.body).toEqual(accepted.body);
    const replayCommand = randomUUID();
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: replayCommand })
      .expect(200);
    expect(
      await f.db.prisma.workspaceInvitationCommand.count({
        where: {
          workspaceId: f.w.id,
          commandId: replayCommand,
          kind: 'ACCEPT',
        },
      }),
    ).toBe(1);
    await owner
      .post('/api/v1/provider/workspace-invitations')
      .set('x-workspace-id', f.w.id)
      .send({ email: `${randomUUID()}@invite.test`, commandId: replayCommand })
      .expect(409);
    expect(accepted.body).toMatchObject({
      workspaceId: f.w.id,
      role: 'AGENT',
      status: 'ACTIVE',
    });
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: account.id },
      }),
    ).toBe(1);
    expect(
      await f.db.prisma.workspaceSeatReservation.count({
        where: { workspaceId: f.w.id, releasedAt: null },
      }),
    ).toBe(0);
  });
  it('rotates on resend and makes previous tokens unusable', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const response = await f.invite(owner, account.email),
      old = f.secret(account.email, 'invitation');
    const row = response.body as { id: string; revision: number };
    await owner
      .post(`/api/v1/provider/workspace-invitations/${row.id}/resend`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: row.revision, commandId: randomUUID() })
      .expect(201);
    const fresh = f.secret(account.email, 'invitation');
    expect(fresh).not.toBe(old);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token: old, commandId: randomUUID() })
      .expect(404);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token: fresh, commandId: randomUUID() })
      .expect(200);
  });
});
