import { AuditLifecycleFixture } from './audit-lifecycle.fixture';
jest.setTimeout(60000);
describe('Closed cross-workspace profile Audit', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(2));
  afterAll(() => f.stop());
  async function pair() {
    const a = await f.applicant(),
      ids = [await f.published(0), await f.published(1)],
      apps: string[] = [];
    for (const id of ids) {
      const r = await a.client.post(`/api/v1/listings/${id}/apply`).expect(201);
      apps.push((r.body as { id: string }).id);
    }
    return { ...a, ids, apps };
  }
  it('audits eligibility rejection in each exact workspace in the original transaction', async () => {
    const a = await pair();
    await a.client
      .patch('/api/v1/applicant/profile')
      .send({ householdNetIncome: 100 })
      .expect(200);
    for (const id of a.ids) {
      const rows = await f.events(id),
        event = rows.find((e) => e.action === 'application.rejected');
      expect(event).toMatchObject({
        actorKind: 'SYSTEM',
        actorUserId: null,
        actorMembershipId: null,
        systemPurpose: 'APPLICATION_ELIGIBILITY_REVALIDATION',
        changes: { previousStatus: 'ACTIVE', newStatus: 'REJECTED' },
      });
      expect(event?.workspaceId).toBe(
        (await f.db.prisma.listing.findUniqueOrThrow({ where: { id } }))
          .workspaceId,
      );
    }
    expect(await f.db.prisma.auditProfileScope.count()).toBe(0);
    expect(await f.db.prisma.auditProfileBinding.count()).toBe(0);
    expect(await f.db.prisma.auditExecutionContext.count()).toBe(0);
    expect(
      await f.db.runtimeSql(
        null,
        async (c) => (await c.query('SELECT id FROM listings')).rowCount,
      ),
    ).toBe(0);
  });
  it('rolls back profile, both workspace consequences and activities on required append failure', async () => {
    const a = await pair(),
      before = await f.db.prisma.applicantProfile.findUniqueOrThrow({
        where: { applicantId: a.id },
      });
    const lastApplication = [...a.apps].sort().at(-1)!;
    const lastWorkspace = f.workspaces[a.apps.indexOf(lastApplication)].id;
    await f.fail(
      'application.rejected',
      async () => {
        const r = await a.client
          .patch('/api/v1/applicant/profile')
          .send({ householdNetIncome: 100 });
        expect(r.status).toBe(500);
      },
      lastWorkspace,
    );
    expect(
      await f.db.prisma.applicantProfile.findUniqueOrThrow({
        where: { applicantId: a.id },
      }),
    ).toEqual(before);
    expect(
      (
        await f.db.prisma.application.findMany({
          where: { id: { in: a.apps } },
        })
      ).every((a) => a.status === 'ACTIVE'),
    ).toBe(true);
    expect(
      await f.db.prisma.applicationActivity.count({
        where: { applicationId: { in: a.apps }, type: 'APPLICATION_REJECTED' },
      }),
    ).toBe(0);
    for (const id of a.ids)
      expect((await f.events(id)).map((e) => e.action)).toEqual([
        'application.submitted',
      ]);
    expect(await f.db.prisma.auditProfileScope.count()).toBe(0);
    expect(await f.db.prisma.auditProfileBinding.count()).toBe(0);
  });
  it('profile validation errors retain their HTTP contract', async () => {
    const a = await f.applicant();
    await a.client
      .patch('/api/v1/applicant/profile')
      .send({ introduction: '' })
      .expect(400);
    expect(await f.db.prisma.auditProfileScope.count()).toBe(0);
  });
});
