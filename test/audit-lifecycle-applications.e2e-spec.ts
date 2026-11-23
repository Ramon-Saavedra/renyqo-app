import { AuditLifecycleFixture } from './audit-lifecycle.fixture';
jest.setTimeout(60000);
describe('Application lifecycle required Audit through HTTP', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(2));
  afterAll(() => f.stop());
  const apply = async () => {
    const listingId = await f.published(),
      a = await f.applicant();
    const r = await a.client
      .post(`/api/v1/listings/${listingId}/apply`)
      .expect(201);
    return { ...a, listingId, applicationId: (r.body as { id: string }).id };
  };
  it('records submission and withdrawal as USER, retains activity and no-ops on withdrawal replay', async () => {
    const a = await apply();
    let rows = await f.events(a.listingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'application.submitted',
      actorKind: 'USER',
      actorUserId: a.id,
      actorMembershipId: null,
      resourceId: a.applicationId,
      changes: { previousStatus: null, newStatus: 'ACTIVE' },
    });
    const url = `/api/v1/applicant/applications/${a.applicationId}`;
    await a.client.delete(url).expect(200);
    await a.client.delete(url).expect(200);
    rows = await f.events(a.listingId);
    expect(rows.map((e) => e.action)).toEqual([
      'application.submitted',
      'application.withdrawn',
    ]);
    expect(
      await f.db.prisma.applicationActivity.count({
        where: {
          applicationId: a.applicationId,
          type: 'APPLICATION_WITHDRAWN',
        },
      }),
    ).toBe(1);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(a.email);
    expect(stored).not.toContain('Private applicant');
    expect(stored).not.toContain('An eligible test applicant');
  });
  it('records provider rejection with MEMBER actor and keeps business chronology separate', async () => {
    const a = await apply(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    await owner
      .patch(`/api/v1/provider/applications/${a.applicationId}/reject`)
      .set('x-workspace-id', w.id)
      .expect(200);
    const row = (await f.events(a.listingId)).find(
      (e) => e.action === 'application.rejected',
    );
    expect(row).toMatchObject({
      actorKind: 'MEMBER',
      actorUserId: w.ownerUser,
      actorMembershipId: w.owner,
      resourceId: a.applicationId,
      listingId: a.listingId,
      changes: { previousStatus: 'ACTIVE', newStatus: 'REJECTED' },
    });
    expect(row?.actorUserId).not.toBe(a.id);
    expect(
      await f.db.prisma.applicationActivity.count({
        where: { applicationId: a.applicationId, type: 'APPLICATION_REJECTED' },
      }),
    ).toBe(1);
    expect(
      await f.db.prisma.listingEvent.count({
        where: { applicationId: a.applicationId, type: 'REJECTED_BY_PROVIDER' },
      }),
    ).toBe(1);
  });
  it('rolls back withdrawal, activity, outbox and notification intent if Audit fails', async () => {
    const a = await apply();
    const activities = await f.db.prisma.applicationActivity.count({
        where: { applicationId: a.applicationId },
      }),
      outbox = await f.db.prisma.outboxEvent.count();
    await f.fail('application.withdrawn', async () => {
      const r = await a.client.delete(
        `/api/v1/applicant/applications/${a.applicationId}`,
      );
      expect(r.status).toBe(500);
    });
    expect(
      await f.db.prisma.application.findUniqueOrThrow({
        where: { id: a.applicationId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await f.db.prisma.applicationActivity.count({
        where: { applicationId: a.applicationId },
      }),
    ).toBe(activities);
    expect(await f.db.prisma.outboxEvent.count()).toBe(outbox);
    expect((await f.events(a.listingId)).map((e) => e.action)).toEqual([
      'application.submitted',
    ]);
  });
  it('denies foreign provider decisions without success evidence', async () => {
    const a = await apply(),
      foreign = await f.login(f.workspaces[1].ownerUser);
    await foreign
      .patch(`/api/v1/provider/applications/${a.applicationId}/reject`)
      .set('x-workspace-id', f.workspaces[1].id)
      .expect(404);
    expect((await f.events(a.listingId)).map((e) => e.action)).toEqual([
      'application.submitted',
    ]);
  });
  it('tenant selection records the provider, chosen application and other rejections atomically', async () => {
    const a = await apply(),
      b = await f.applicant(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const r = await b.client
        .post(`/api/v1/listings/${a.listingId}/apply`)
        .expect(201),
      other = (r.body as { id: string }).id;
    await owner
      .patch(`/api/v1/provider/listings/${a.listingId}/rent`)
      .set('x-workspace-id', w.id)
      .send({ selectedApplicationId: a.applicationId })
      .expect(200);
    const rows = await f.events(a.listingId);
    expect(
      rows.find((e) => e.action === 'provider.listing.rented'),
    ).toMatchObject({
      changes: {
        previousStatus: 'PUBLISHED',
        newStatus: 'RENTED',
        selectedApplicationId: a.applicationId,
      },
    });
    expect(
      rows.find((e) => e.action === 'application.tenant_selected'),
    ).toMatchObject({
      actorKind: 'MEMBER',
      actorUserId: w.ownerUser,
      resourceId: a.applicationId,
    });
    expect(rows.find((e) => e.action === 'application.rejected')).toMatchObject(
      { resourceId: other, actorUserId: w.ownerUser },
    );
    expect(
      await f.db.prisma.publicListingProjection.count({
        where: { id: a.listingId },
      }),
    ).toBe(0);
    await owner
      .patch(`/api/v1/provider/listings/${a.listingId}/rent`)
      .set('x-workspace-id', w.id)
      .send({ selectedApplicationId: a.applicationId })
      .expect(409);
    expect(await f.events(a.listingId)).toHaveLength(rows.length);
  });
});
