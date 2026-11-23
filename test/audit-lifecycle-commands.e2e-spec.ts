import { AuditLifecycleFixture } from './audit-lifecycle.fixture';

jest.setTimeout(60000);
describe('Listing ordering, status races and application restoration Audit', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(1));
  afterAll(() => f.stop());
  it('manual reorder records final positions once and failed Audit rolls back ordering', async () => {
    const first = await f.published(),
      second = await f.published(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const move = (id: string, position: number) =>
      owner
        .patch(`/api/v1/provider/listings/${id}/position`)
        .set('x-workspace-id', w.id)
        .send({ position });
    await move(second, 1).expect(200);
    const reordered = (await f.events(second)).filter(
      (e) => e.action === 'provider.listing.order_changed',
    );
    expect(reordered).toHaveLength(1);
    expect(reordered[0].changes).toMatchObject({ newPosition: 1 });
    const count = (await f.events(second)).length;
    await move(second, 1).expect(200);
    expect(await f.events(second)).toHaveLength(count);
    const before = await f.db.prisma.listing.findMany({
      where: { workspaceId: w.id },
      orderBy: { id: 'asc' },
    });
    await f.fail('provider.listing.order_changed', async () => {
      const response = await move(first, 1);
      expect(response.status).toBe(500);
    });
    expect(
      await f.db.prisma.listing.findMany({
        where: { workspaceId: w.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });
  it('competing pauses record only the successful state transition', async () => {
    const listingId = await f.published(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const pause = () =>
      owner
        .patch(`/api/v1/provider/listings/${listingId}/pause`)
        .set('x-workspace-id', w.id);
    const results = await Promise.all([pause(), pause()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await f.events(listingId)).map((e) => e.changes)).toEqual([
      {
        previousStatus: 'PUBLISHED',
        newStatus: 'PAUSED',
        changedFieldNames: [],
      },
    ]);
  });
  it('restores a historical rejected application using current provider authority', async () => {
    const listingId = await f.published(),
      a = await f.applicant(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    // Seed a prior business state rather than waiting for or disabling cooldown.
    const application = await f.db.prisma.application.create({
      data: {
        listingId,
        applicantId: a.id,
        status: 'REJECTED',
        publicReason: 'NOT_SELECTED',
        rejectedAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
    await f.db.prisma.listingEvent.create({
      data: {
        listingId,
        applicationId: application.id,
        type: 'REJECTED_BY_PROVIDER',
        source: 'PROVIDER',
        actorUserId: w.ownerUser,
        occurredAt: new Date('2025-01-01T00:00:00Z'),
      },
    });
    await owner
      .patch(`/api/v1/provider/applications/${application.id}/restore`)
      .set('x-workspace-id', w.id)
      .expect(200);
    expect(
      (await f.events(listingId)).map((e) => ({
        action: e.action,
        changes: e.changes,
      })),
    ).toEqual([
      {
        action: 'application.restored',
        changes: { previousStatus: 'REJECTED', newStatus: 'ACTIVE' },
      },
    ]);
    expect(
      await f.db.prisma.applicationActivity.count({
        where: { applicationId: application.id, type: 'APPLICATION_RESTORED' },
      }),
    ).toBe(1);
  });
});
