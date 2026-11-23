import { ACTIVE_APPLICATIONS_LIMIT } from '../src/applications/application-lifecycle.constants';
import { randomUUID } from 'node:crypto';
import { AuditLifecycleFixture } from './audit-lifecycle.fixture';
import { AuditQuery } from '../src/audit/queries/audit-query';
import { AuditSignals } from '../src/audit/observability/audit-signals';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { ViewingWorkflowCommandService } from '../src/application-viewings/viewing-workflow-command.service';
import { ViewingWorkflowExpiryService } from '../src/application-viewings/viewing-workflow-expiry.service';
jest.setTimeout(60000);
describe('Closed SYSTEM consequences and durable provider consideration', () => {
  const f = new AuditLifecycleFixture();
  beforeAll(() => f.start(1));
  afterAll(() => f.stop());
  afterEach(() => jest.restoreAllMocks());
  it('promotion has explicit SYSTEM purpose and WAITING submission stays out of the OWNER reader', async () => {
    const id = await f.published(),
      active = await f.applicant();
    const first = await active.client
      .post(`/api/v1/listings/${id}/apply`)
      .expect(201);
    const users = await Promise.all(
      Array.from({ length: ACTIVE_APPLICATIONS_LIMIT - 1 }, () => f.db.user()),
    );
    await f.db.prisma.application.createMany({
      data: users.map((applicantId) => ({
        listingId: id,
        applicantId,
        status: 'ACTIVE' as const,
        activeAt: new Date(),
      })),
    });
    const waiting = await f.applicant(),
      response = await waiting.client
        .post(`/api/v1/listings/${id}/apply`)
        .expect(201),
      waitingId = (response.body as { id: string }).id;
    expect(
      await f.db.prisma.application.findUniqueOrThrow({
        where: { id: waitingId },
      }),
    ).toMatchObject({ status: 'WAITING' });
    const authority = await f.db.session(f.workspaces[0].ownerUser),
      query = new AuditQuery(
        f.db.applicationRuntime as PrismaService,
        f.db.resolver,
        new AuditSignals(),
      );
    const page = await query.page(authority, f.workspaces[0].id, {
      limit: 100,
    });
    expect(page.rows.some((r) => r.resourceId === waitingId)).toBe(false);
    await active.client
      .delete(
        `/api/v1/applicant/applications/${(first.body as { id: string }).id}`,
      )
      .expect(200);
    expect(
      (await f.events(id)).find((e) => e.action === 'application.promoted'),
    ).toMatchObject({
      actorKind: 'SYSTEM',
      actorUserId: null,
      actorMembershipId: null,
      systemPurpose: 'APPLICATION_QUEUE_RECONCILIATION',
      resourceId: waitingId,
      source: 'INTERNAL',
      changes: { previousStatus: 'WAITING', newStatus: 'ACTIVE' },
    });
    expect(await f.db.prisma.auditActivitySource.count()).toBe(0);
  });
  it('resume coordinates listing evidence with actual queue promotion', async () => {
    const id = await f.published(),
      active = await f.applicant(),
      w = f.workspaces[0];
    const applied = await active.client
      .post(`/api/v1/listings/${id}/apply`)
      .expect(201);
    const users = await Promise.all(
      Array.from({ length: ACTIVE_APPLICATIONS_LIMIT - 1 }, () => f.db.user()),
    );
    await f.db.prisma.application.createMany({
      data: users.map((applicantId) => ({
        listingId: id,
        applicantId,
        status: 'ACTIVE' as const,
        activeAt: new Date(),
      })),
    });
    const waiting = await f.applicant();
    const response = await waiting.client
      .post(`/api/v1/listings/${id}/apply`)
      .expect(201);
    const waitingId = (response.body as { id: string }).id,
      owner = await f.login(w.ownerUser);
    await owner
      .patch(`/api/v1/provider/listings/${id}/pause`)
      .set('x-workspace-id', w.id)
      .expect(200);
    await active.client
      .delete(
        `/api/v1/applicant/applications/${(applied.body as { id: string }).id}`,
      )
      .expect(200);
    expect(
      await f.db.prisma.application.findUniqueOrThrow({
        where: { id: waitingId },
      }),
    ).toMatchObject({ status: 'WAITING' });
    await owner
      .patch(`/api/v1/provider/listings/${id}/resume`)
      .set('x-workspace-id', w.id)
      .expect(200);
    const events = await f.events(id);
    expect(events.filter((e) => e.action === 'application.promoted')).toEqual([
      expect.objectContaining({
        resourceId: waitingId,
        actorKind: 'SYSTEM',
        systemPurpose: 'APPLICATION_QUEUE_RECONCILIATION',
      }),
    ]);
    expect(
      events.filter((e) => e.action === 'provider.listing.published'),
    ).toHaveLength(1);
    expect(
      await f.db.prisma.application.findUniqueOrThrow({
        where: { id: waitingId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
  });
  it('consideration preserves the viewing receipt and expiry records a narrowly scoped SYSTEM rejection', async () => {
    const id = await f.published(),
      a = await f.applicant(),
      r = await a.client.post(`/api/v1/listings/${id}/apply`).expect(201),
      appId = (r.body as { id: string }).id;
    let now = new Date('2027-01-01T10:00:00Z');
    jest.spyOn(f.app.get(ViewingClock), 'now').mockImplementation(() => now);
    const commands = f.app.get(ViewingWorkflowCommandService),
      owner = {
        workspaceId: f.workspaces[0].id,
        authority: await f.db.session(f.workspaces[0].ownerUser),
      },
      applicant = await f.db.session(a.id);
    const body = async () => ({
      requestKey: randomUUID(),
      expectedWorkflowRevision:
        (
          await f.db.prisma.viewingWorkflow.findUnique({
            where: { applicationId: appId },
          })
        )?.revision ?? 0,
    });
    const p = await commands.execute(appId, owner, 'provider', {
      action: 'invite',
      body: {
        ...(await body()),
        startsAt: '2027-01-03T10:00:00Z',
        endsAt: '2027-01-03T10:30:00Z',
        timeZone: 'Europe/Berlin',
        shortNotice: false,
      },
    });
    const accepted = await commands.execute(appId, applicant, 'applicant', {
      action: 'accept',
      proposalId: p.proposalId!,
      body: await body(),
    });
    now = new Date('2027-01-03T10:30:00Z');
    await commands.execute(appId, owner, 'provider', {
      action: 'outcome',
      appointmentId: accepted.appointmentId!,
      body: { ...(await body()), outcome: 'COMPLETED' },
    });
    const command = {
      action: 'consideration' as const,
      appointmentId: accepted.appointmentId!,
      body: {
        ...(await body()),
        consideration: 'CONTINUE_CONSIDERING' as const,
      },
    };
    await commands.execute(appId, owner, 'provider', command);
    await commands.execute(appId, owner, 'provider', command);
    const events = await f.events(id);
    expect(
      events.filter((e) => e.action === 'application.consideration_recorded'),
    ).toHaveLength(1);
    expect(
      events.find((e) => e.action === 'application.consideration_recorded'),
    ).toMatchObject({
      actorKind: 'MEMBER',
      actorMembershipId: f.workspaces[0].owner,
      resourceId: appId,
      changes: { decision: 'CONTINUE_CONSIDERING' },
    });
    now = (
      await f.db.prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: accepted.appointmentId! },
      })
    ).interestDeadlineAt!;
    const expiry = f.app.get(ViewingWorkflowExpiryService),
      target = {
        applicationId: appId,
        id: accepted.appointmentId!,
        kind: 'interest' as const,
      };
    expect(await expiry.processTarget(target)).toBe(true);
    expect(await expiry.processTarget(target)).toBe(false);
    const rejected = (await f.events(id)).filter(
      (e) => e.action === 'application.rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      actorKind: 'SYSTEM',
      actorUserId: null,
      systemPurpose: 'APPLICATION_VIEWING_INTEREST_EXPIRY',
      resourceId: appId,
    });
    expect(await f.db.prisma.auditActivitySource.count()).toBe(0);
  });
});
