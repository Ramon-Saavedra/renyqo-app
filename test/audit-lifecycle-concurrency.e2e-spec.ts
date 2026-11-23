import { AuditLifecycleFixture } from './audit-lifecycle.fixture';

jest.setTimeout(60000);
describe('Committed lifecycle decisions have exactly one Audit effect', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(1));
  afterAll(() => f.stop());
  async function target() {
    const listingId = await f.published(),
      applicant = await f.applicant();
    const response = await applicant.client
      .post(`/api/v1/listings/${listingId}/apply`)
      .expect(201);
    return {
      ...applicant,
      listingId,
      applicationId: (response.body as { id: string }).id,
    };
  }
  it('competing provider rejections record only the committed rejection', async () => {
    const a = await target(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const reject = () =>
      owner
        .patch(`/api/v1/provider/applications/${a.applicationId}/reject`)
        .set('x-workspace-id', w.id);
    const results = await Promise.all([reject(), reject()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await f.events(a.listingId)).filter(
        (e) => e.action === 'application.rejected',
      ),
    ).toHaveLength(1);
  });
  it('withdrawal versus rejection retains only successful transition evidence', async () => {
    const a = await target(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const results = await Promise.all([
      a.client.delete(`/api/v1/applicant/applications/${a.applicationId}`),
      owner
        .patch(`/api/v1/provider/applications/${a.applicationId}/reject`)
        .set('x-workspace-id', w.id),
    ]);
    const app = await f.db.prisma.application.findUniqueOrThrow({
      where: { id: a.applicationId },
    });
    const events = (await f.events(a.listingId)).filter(
      (e) => e.action !== 'application.submitted',
    );
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].changes).toMatchObject({ newStatus: app.status });
    expect(['WITHDRAWN', 'REJECTED']).toContain(app.status);
  });
  it('competing tenant selections cannot both create successful rental evidence', async () => {
    const a = await target(),
      b = await f.applicant(),
      w = f.workspaces[0],
      owner = await f.login(w.ownerUser);
    const response = await b.client
      .post(`/api/v1/listings/${a.listingId}/apply`)
      .expect(201);
    const select = (id: string) =>
      owner
        .patch(`/api/v1/provider/listings/${a.listingId}/rent`)
        .set('x-workspace-id', w.id)
        .send({ selectedApplicationId: id });
    const results = await Promise.all([
      select(a.applicationId),
      select((response.body as { id: string }).id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const events = await f.events(a.listingId);
    expect(
      events.filter((e) => e.action === 'provider.listing.rented'),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.action === 'application.tenant_selected'),
    ).toHaveLength(1);
    expect(
      await f.db.prisma.application.count({
        where: { listingId: a.listingId, status: 'ACCEPTED' },
      }),
    ).toBe(1);
  });
});
