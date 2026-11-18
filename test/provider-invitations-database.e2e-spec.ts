import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { admitFixtureAgent } from './invitation-admission.fixture';
jest.setTimeout(60000);
describe('Restricted-login invitation database invariants', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('cannot insert an AGENT even when a free seat exists without admission evidence', async () => {
    const user = await f.db.user();
    await expect(
      f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `INSERT INTO workspace_memberships(id,workspace_id,user_id,role,display_color) VALUES($1,$2,$3,'AGENT','#123456')`,
          [randomUUID(), f.w.id, user],
        );
      }),
    ).rejects.toMatchObject({ constraint: 'INVITATION_ADMISSION_REQUIRED' });
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: user },
      }),
    ).toBe(0);
  });
  it('keeps invitation tables invisible without tenant context and prevents raw acceptance', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email);
    expect(
      await f.db.runtimeSql(
        null,
        async (c) =>
          (await c.query('SELECT id FROM workspace_invitations')).rowCount,
      ),
    ).toBe(0);
    await expect(
      f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `UPDATE workspace_invitations SET status='ACCEPTED',accepted_membership_id=$2,accepted_user_id=$3,acceptance_kind='ALREADY_MEMBER' WHERE id=$1`,
          [body.id, f.w.owner, f.w.ownerUser],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await f.db.prisma.workspaceInvitation.findUniqueOrThrow({
          where: { id: body.id },
        })
      ).status,
    ).toBe('PENDING');
  });
  it('protects immutable intent, history and command evidence', async () => {
    const owner = await f.owner(),
      account = await f.account();
    const { body } = await f.invite(owner, account.email);
    await expect(
      f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `UPDATE workspace_invitations SET email='changed@invite.test' WHERE id=$1`,
          [body.id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
    for (const table of [
      'workspace_invitations',
      'workspace_invitation_commands',
    ])
      await expect(
        f.db.runtimeSql(f.w.id, async (c) => c.query(`DELETE FROM ${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('does not resume SUSPENDED or reinstate REMOVED canonical membership identities', async () => {
    for (const status of ['SUSPENDED', 'REMOVED']) {
      const owner = await f.owner(),
        account = await f.account();
      await f.verify(account);
      const { body } = await f.invite(owner, account.email),
        token = f.secret(account.email, 'invitation');
      // A different legitimate invitation admits first, modeling pre-existing membership
      // at the acceptance boundary without weakening the deferred proof.
      await owner
        .post(`/api/v1/provider/workspace-invitations/${body.id}/revoke`)
        .set('x-workspace-id', f.w.id)
        .send({ revision: body.revision, commandId: randomUUID() })
        .expect(201);
      const member = await admitFixtureAgent(f.db, f.w.id, account.id);
      await f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1`,
          [member, status],
        );
      });
      await account.client
        .post('/api/v1/workspace-invitations/accept')
        .send({ token, commandId: randomUUID() })
        .expect(404);
      await owner
        .post('/api/v1/provider/workspace-invitations')
        .set('x-workspace-id', f.w.id)
        .send({ email: account.email, commandId: randomUUID() })
        .expect(409);
      expect(
        (
          await f.db.prisma.workspaceMembership.findUniqueOrThrow({
            where: { id: member },
          })
        ).status,
      ).toBe(status);
      expect(
        await f.db.prisma.workspaceMembership.count({
          where: { workspaceId: f.w.id, userId: account.id },
        }),
      ).toBe(1);
    }
  });
  it('consumes redundant admission without resetting the existing membership identity, role, color or revision', async () => {
    const member = await f.db.prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: f.w.agents[0].id },
    });
    await admitFixtureAgent(f.db, f.w.id, member.userId, member.id);
    expect(
      await f.db.prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: member.id },
      }),
    ).toEqual(member);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: member.userId },
      }),
    ).toBe(1);
  });
  it('OWNER suspension/resumption invalidates outstanding issuance until explicit resend', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const { body } = await f.invite(owner, account.email),
      token = f.secret(account.email, 'invitation');
    for (const status of ['SUSPENDED', 'ACTIVE'])
      await f.db.runtimeSql(f.w.id, async (c) => {
        await c.query('SELECT lock_workspace_ownership_revision($1,1)', [
          f.w.id,
        ]);
        await c.query(
          `UPDATE workspace_memberships SET status=$2::"WorkspaceMembershipStatus" WHERE id=$1`,
          [f.w.owner, status],
        );
      });
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(409);
    await owner
      .post(`/api/v1/provider/workspace-invitations/${body.id}/resend`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: body.revision, commandId: randomUUID() })
      .expect(201);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({
        token: f.secret(account.email, 'invitation'),
        commandId: randomUUID(),
      })
      .expect(200);
  });
  it('accepted replay is denied after the recipient membership is suspended', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    const token = f.secret(account.email, 'invitation'),
      commandId = randomUUID();
    const result = await account.client
        .post('/api/v1/workspace-invitations/accept')
        .send({ token, commandId })
        .expect(200),
      member = result.body as { id: string };
    await f.db.runtimeSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        `UPDATE workspace_memberships SET status='SUSPENDED' WHERE id=$1`,
        [member.id],
      );
    });
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId })
      .expect(409);
  });
  it('invalidates issuer authority epochs while ordinary membership revisions remain unchanged on admission', async () => {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    const token = f.secret(account.email, 'invitation');
    await f.db.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { authVersion: { increment: 1 } },
    });
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({ token, commandId: randomUUID() })
      .expect(409);
    expect(
      await f.db.prisma.workspaceMembership.count({
        where: { workspaceId: f.w.id, userId: account.id },
      }),
    ).toBe(0);
    expect(
      (
        await f.db.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: f.w.id },
        })
      ).ownershipRevision,
    ).toBe(1);
  });
});
