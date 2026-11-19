import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
import { MEMBER_COLOR_IDS } from '../src/member-presentation/member-color.catalog';
jest.setTimeout(90000);
describe('Canonical member presentation HTTP', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  async function accept(color?: (typeof MEMBER_COLOR_IDS)[number]) {
    const owner = await f.owner(),
      account = await f.account();
    await f.verify(account);
    const response = await f.invite(owner, account.email, randomUUID(), color);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({
        token: f.secret(account.email, 'invitation'),
        commandId: randomUUID(),
      })
      .expect(200);
    const member = await f.db.prisma.workspaceMembership.findUniqueOrThrow({
      where: {
        workspaceId_userId: { workspaceId: f.w.id, userId: account.id },
      },
    });
    return { owner, account, member, invitation: response.body };
  }
  it('normalizes existing members deterministically and exposes OWNER-only usage, not unavailable colors', async () => {
    const owner = await f.owner(),
      members = await f.db.prisma.workspaceMembership.findMany({
        where: { workspaceId: f.w.id },
      });
    expect(new Set(members.map((m) => m.displayColor)).size).toBe(3);
    const response = await owner
      .get('/api/v1/provider/team/member-colors')
      .set('x-workspace-id', f.w.id)
      .expect(200);
    const palette = response.body as {
      colors: {
        id: string;
        currentUsageCount: number;
        currentlyUnused: boolean;
        recommended: boolean;
      }[];
      canRecolor: boolean;
    };
    expect(palette.colors).toHaveLength(MEMBER_COLOR_IDS.length);
    expect(palette.canRecolor).toBe(false);
    expect(palette.colors.filter((c) => c.recommended)).toHaveLength(1);
    expect(
      palette.colors.reduce((sum, c) => sum + c.currentUsageCount, 0),
    ).toBe(3);
  });
  it('uses an unused OWNER choice, preserves intent on resend and prevents AGENT administration', async () => {
    const result = await accept('INDUSTRIAL_YELLOW');
    expect(result.member.displayColor).toBe('INDUSTRIAL_YELLOW');
    expect(result.invitation.requestedColorId).toBe('INDUSTRIAL_YELLOW');
    await result.account.client
      .get('/api/v1/provider/team/member-colors')
      .set('x-workspace-id', f.w.id)
      .expect(403);
    const account = await f.account();
    const { body } = await f.invite(
      result.owner,
      account.email,
      randomUUID(),
      'FUCHSIA',
    );
    const response = await result.owner
      .post(`/api/v1/provider/workspace-invitations/${body.id}/resend`)
      .set('x-workspace-id', f.w.id)
      .send({ revision: body.revision, commandId: randomUUID() })
      .expect(201);
    expect(
      (response.body as { requestedColorId: string }).requestedColorId,
    ).toBe('FUCHSIA');
  });
  it('falls back for an occupied choice without changing the original member or security epochs', async () => {
    const before = await f.db.prisma.workspaceMembership.findMany({
      where: { workspaceId: f.w.id },
      orderBy: { id: 'asc' },
    });
    const { member } = await accept('INDUSTRIAL_YELLOW');
    expect(member.displayColor).not.toBe('INDUSTRIAL_YELLOW');
    expect(member.revision).toBe(1);
    expect(
      await f.db.prisma.workspaceMembership.findMany({
        where: { id: { in: before.map((m) => m.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    expect(
      (
        await f.db.prisma.providerWorkspace.findUniqueOrThrow({
          where: { id: f.w.id },
        })
      ).ownershipRevision,
    ).toBe(1);
  });
  it('rejects raw hex, CSS and forged actor snapshots at the public boundary', async () => {
    const owner = await f.owner();
    for (const value of ['#FF0000', 'url(x)', '<style>'])
      await owner
        .post('/api/v1/provider/workspace-invitations')
        .set('x-workspace-id', f.w.id)
        .send({
          email: `${randomUUID()}@color.test`,
          commandId: randomUUID(),
          requestedColorId: value,
        })
        .expect(400);
    await owner
      .post('/api/v1/provider/workspace-invitations')
      .set('x-workspace-id', f.w.id)
      .send({
        email: `${randomUUID()}@color.test`,
        commandId: randomUUID(),
        actorSnapshot: { actorRoleAtTime: 'OWNER' },
      })
      .expect(400);
  });
});
