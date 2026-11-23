import { randomUUID } from 'node:crypto';
import { AuditLifecycleFixture } from './audit-lifecycle.fixture';
jest.setTimeout(60000);
describe('Listing lifecycle required Audit through HTTP', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(2));
  afterAll(() => f.stop());
  it('records creation and bounded updates, replay/no-op add no evidence, rejected publication adds none', async () => {
    const w = f.workspaces[0],
      owner = await f.login(w.ownerUser),
      commandId = randomUUID();
    const body = { commandId, title: 'Sensitive original title' };
    const first = await owner
        .post('/api/v1/provider/listings')
        .set('x-workspace-id', w.id)
        .send(body)
        .expect(201),
      id = (first.body as { id: string }).id;
    await owner
      .post('/api/v1/provider/listings')
      .set('x-workspace-id', w.id)
      .send(body)
      .expect(201);
    expect((await f.events(id)).map((e) => e.action).sort()).toEqual(
      [
        'provider.listing.created',
        'provider.listing_assignment.changed',
      ].sort(),
    );
    await owner
      .patch(`/api/v1/provider/listings/${id}`)
      .set('x-workspace-id', w.id)
      .send({ title: 'Private updated title' })
      .expect(200);
    const rows = await f.events(id),
      update = rows.find((e) => e.action === 'provider.listing.updated');
    expect(update).toMatchObject({
      actorKind: 'MEMBER',
      actorMembershipId: w.owner,
      resourceId: id,
      changes: {
        previousStatus: 'DRAFT',
        newStatus: 'DRAFT',
        changedFieldNames: ['title'],
      },
    });
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('Sensitive original title');
    expect(stored).not.toContain('Private updated title');
    await owner
      .patch(`/api/v1/provider/listings/${id}`)
      .set('x-workspace-id', w.id)
      .send({ title: 'Private updated title' })
      .expect(200);
    await owner
      .patch(`/api/v1/provider/listings/${id}/publish`)
      .set('x-workspace-id', w.id)
      .expect(422);
    expect(await f.events(id)).toHaveLength(rows.length);
  });
  it('rolls back listing, assignment receipt and all Audit when creation Audit fails', async () => {
    const w = f.workspaces[0],
      owner = await f.login(w.ownerUser),
      commandId = randomUUID();
    await f.fail('provider.listing.created', async () => {
      const r = await owner
        .post('/api/v1/provider/listings')
        .set('x-workspace-id', w.id)
        .send({ commandId, title: 'Rollback' });
      expect(r.status).toBe(500);
    });
    expect(
      await f.db.prisma.listingAssignmentTransition.count({
        where: { workspaceId: w.id, commandId },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.auditEvent.count({
        where: { workspaceId: w.id, commandId },
      }),
    ).toBe(0);
    expect(
      await f.db.prisma.listing.count({
        where: { workspaceId: w.id, title: 'Rollback' },
      }),
    ).toBe(0);
  });
  it('records pause, resume, unpublish, publish and retirement with actual before/after states', async () => {
    const id = await f.published(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    for (const action of ['pause', 'resume', 'draft'])
      await owner
        .patch(`/api/v1/provider/listings/${id}/${action}`)
        .set('x-workspace-id', w.id)
        .expect(200);
    // Complete required publication data through the real update command.
    await owner
      .patch(`/api/v1/provider/listings/${id}`)
      .set('x-workspace-id', w.id)
      .send({
        title: 'Publishable',
        street: 'Hidden street',
        zip: '10115',
        city: 'Berlin',
        livingArea: 60,
        rooms: 2,
        bedrooms: 1,
        coldRent: 800,
        availableFrom: '2026-12-01T00:00:00.000Z',
      })
      .expect(200);
    await owner
      .patch(`/api/v1/provider/listings/${id}/publish`)
      .set('x-workspace-id', w.id)
      .expect(200);
    await owner
      .patch(`/api/v1/provider/listings/${id}/retire`)
      .set('x-workspace-id', w.id)
      .expect(200);
    const rows = await f.events(id);
    expect(
      rows
        .filter((e) => e.changes && e.action !== 'provider.listing.updated')
        .map((e) => e.changes),
    ).toEqual([
      {
        previousStatus: 'PUBLISHED',
        newStatus: 'PAUSED',
        changedFieldNames: [],
      },
      {
        previousStatus: 'PAUSED',
        newStatus: 'PUBLISHED',
        changedFieldNames: [],
      },
      {
        previousStatus: 'PUBLISHED',
        newStatus: 'DRAFT',
        changedFieldNames: [],
      },
      {
        previousStatus: 'DRAFT',
        newStatus: 'PUBLISHED',
        changedFieldNames: [],
      },
      {
        previousStatus: 'PUBLISHED',
        newStatus: 'RETIRED',
        changedFieldNames: [],
      },
    ]);
    await owner
      .patch(`/api/v1/provider/listings/${id}/resume`)
      .set('x-workspace-id', w.id)
      .expect(409);
    expect(await f.events(id)).toHaveLength(rows.length);
  });
  it('does not expose/mutate a foreign workspace or record successful evidence', async () => {
    const id = await f.published(1),
      owner = await f.login(f.workspaces[0].ownerUser);
    await owner
      .patch(`/api/v1/provider/listings/${id}`)
      .set('x-workspace-id', f.workspaces[0].id)
      .send({ title: 'Forbidden' })
      .expect(404);
    expect(await f.events(id)).toHaveLength(0);
  });
});
