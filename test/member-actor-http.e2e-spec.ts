import { randomUUID } from 'node:crypto';
import { InvitationFixture } from './provider-invitations.fixture';
jest.setTimeout(60000);
describe('Tenant-safe historical member presentation HTTP', () => {
  const f = new InvitationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());
  it('projects captured/legacy actors internally, never to the applicant, without expanding AGENT scope', async () => {
    const owner = await f.owner(),
      applicant = f.client();
    const registered = await applicant
      .post('/api/v1/auth/register')
      .send({
        name: 'Applicant',
        email: `${randomUUID()}@actor.test`,
        password: 'StrongPass123',
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const applicantId = (registered.body as { id: string }).id,
      listing = await f.db.listing(f.w.id, f.w.owner, f.w.agents[0].id);
    await f.db.applicationSql(f.w.id, async (c) => {
      await c.query('SELECT lock_workspace_ownership_revision($1,1)', [f.w.id]);
      await c.query(
        `UPDATE listings SET status='published',published_at=clock_timestamp() WHERE id=$1`,
        [listing],
      );
    });
    const app = await f.db.prisma.application.create({
      data: {
        listingId: listing,
        applicantId,
        status: 'ACTIVE',
        activeAt: new Date(),
      },
    });
    await f.db.prisma.applicationActivity.create({
      data: {
        applicationId: app.id,
        type: 'APPLICATION_RESTORED',
        actorType: 'PROVIDER',
        visibility: 'BOTH',
        actorUserId: null,
      },
    });
    await owner
      .patch(
        `/api/v1/provider/applications/${app.id}/conversation/applicant-replies`,
      )
      .set('x-workspace-id', f.w.id)
      .send({ applicantRepliesEnabled: true })
      .expect(200);
    const path = `/api/v1/provider/applications/${app.id}/activity`,
      response = await owner
        .get(path)
        .set('x-workspace-id', f.w.id)
        .expect(200);
    type Item = {
      actor?: {
        state: string;
        snapshot: { actorDisplayNameAtTime: string } | null;
      };
    };
    const items = (response.body as { items: Item[] }).items;
    expect(items.some((i) => i.actor?.state === 'LEGACY_UNSNAPSHOTTED')).toBe(
      true,
    );
    const captured = items.find((i) => i.actor?.state === 'CAPTURED');
    expect(captured?.actor?.snapshot).toBeTruthy();
    const publicResponse = await applicant
      .get(`/api/v1/applicant/applications/${app.id}/activity`)
      .expect(200);
    for (const key of [
      'actorSnapshot',
      'actorMembershipId',
      'actorWorkspaceId',
      'actorDisplayNameAtTime',
      'actorColorAtTime',
    ])
      expect(JSON.stringify(publicResponse.body)).not.toContain(key);
    await f.db.prisma.user.update({
      where: { id: f.w.ownerUser },
      data: { name: 'Current renamed owner' },
    });
    const again = await owner
      .get(path)
      .set('x-workspace-id', f.w.id)
      .expect(200);
    expect((again.body as { items: Item[] }).items).toEqual(items);
    const account = await f.account();
    await f.verify(account);
    await f.invite(owner, account.email);
    await account.client
      .post('/api/v1/workspace-invitations/accept')
      .send({
        token: f.secret(account.email, 'invitation'),
        commandId: randomUUID(),
      })
      .expect(200);
    await account.client.get(path).set('x-workspace-id', f.w.id).expect(404);
    await owner.get(path).set('x-workspace-id', randomUUID()).expect(404);
    const waiting = await f.db.prisma.application.create({
      data: {
        listingId: listing,
        applicantId: await f.db.user(),
        status: 'WAITING',
      },
    });
    await owner
      .get(`/api/v1/provider/applications/${waiting.id}/activity`)
      .set('x-workspace-id', f.w.id)
      .expect(404);
  });
});
