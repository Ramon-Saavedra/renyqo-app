import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
jest.setTimeout(60000);
describe('Invitation identity, revocation and delivery boundaries', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('collapses unknown and wrong-identity tokens without exposing a workspace', async () => {
    const owner = await f.owner(),
      intended = await f.account(),
      other = await f.account();
    await f.verify(other);
    await f.invite(owner, intended.email);
    const token = f.secret(intended.email, 'invitation');
    const responses = [];
    for (const value of [token, 'a'.repeat(43)])
      responses.push(
        (
          await other.client
            .post('/api/v1/workspace-invitations/inspect')
            .send({ token: value })
            .expect(404)
        ).body as unknown,
      );
    expect(responses[0]).toEqual(responses[1]);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { userId: other.id, workspaceId: f.w.id },
      }),
    ).toBe(0);
  });
  it('replays creation without sending again; changed input conflicts and normalized duplicate conflicts', async () => {
    const owner = await f.owner(),
      email = `${randomUUID()}@invite.test`,
      commandId = randomUUID();
    const first = await f.invite(owner, email, commandId),
      count = f.mail.length;
    const replay = await f.invite(owner, email, commandId);
    expect(replay.body.id).toBe(first.body.id);
    expect(f.mail).toHaveLength(count);
    for (const input of [
      { email: `${randomUUID()}@invite.test`, commandId },
      { email: `  ${email.toUpperCase()}  `, commandId: randomUUID() },
    ])
      await owner
        .post('/api/v1/provider/workspace-invitations')
        .set('x-workspace-id', f.w.id)
        .send(input)
        .expect(409);
  });
  it('revokes once, releases capacity, preserves evidence and prevents acceptance', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation'),
      commandId = randomUUID();
    const path = `/api/v1/provider/workspace-invitations/${body.id}/revoke`,
      input = { commandId, revision: body.revision };
    await owner
      .post(path)
      .set('x-workspace-id', f.w.id)
      .send(input)
      .expect(201);
    await owner
      .post(path)
      .set('x-workspace-id', f.w.id)
      .send(input)
      .expect(201);
    const row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: body.id },
      include: { reservation: true },
    });
    expect(row.status).toBe('REVOKED');
    expect(row.reservation.releasedAt).not.toBeNull();
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(404);
  });
  it('keeps the invitation valid after ordinary issuer logout', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    const token = f.secret(account.email, 'invitation');
    await owner.post('/api/v1/auth/logout').send({}).expect(200);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(200);
  });
  it('retains committed reservation after delivery failure and recovers only by rotating resend', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    f.transport.sendSecurityLink.mockRejectedValueOnce(
      new Error('Unavailable transport'),
    );
    const { body } = await f.invite(owner, account.email);
    expect(body.delivery).toBe('FAILED');
    const row = await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
      where: { id: body.id },
      include: { reservation: true },
    });
    expect(row.status).toBe('PENDING');
    expect(row.reservation.releasedAt).toBeNull();
    await owner
      .post(`/api/v1/provider/workspace-invitations/${row.id}/resend`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: row.revision, commandId: randomUUID() })
      .expect(201);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({
        token: f.secret(account.email, 'invitation'),
        commandId: randomUUID(),
      })
      .expect(200);
  });
  it('provides OWNER-only safe paginated team projections', async () => {
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
    const response = await owner
      .get('/api/v1/provider/team?page=1&limit=2')
      .set('x-workspace-id', f.w.id)
      .expect(200);
    const body = response.body as { members: unknown[]; memberTotal: number };
    expect(body.members).toHaveLength(2);
    expect(body.memberTotal).toBeGreaterThan(2);
    for (const field of [
      'tokenHash',
      'authVersion',
      'passwordHash',
      'sessionId',
      'issuerMembershipRevision',
    ])
      expect(JSON.stringify(body)).not.toContain(field);
    await account.client
      .get('/api/v1/provider/team')
      .set('x-workspace-id', f.w.id)
      .expect(403);
  });
});
