import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { connected, quietPeriod, realtimeTestApp } from './realtime-test-app';
import { NotificationService } from '../src/notifications/notification.service';
import { NotificationProducer } from '../src/notifications/notification-producer.service';
import { NotificationRetention } from '../src/notifications/notification-retention.service';
import {
  ViewingWorkflowCommandService,
  type ViewingWorkflowCommand,
} from '../src/application-viewings/viewing-workflow-command.service';
import { ViewingWorkflowExpiryService } from '../src/application-viewings/viewing-workflow-expiry.service';
import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ProviderApplicationCurationService } from '../src/applications/provider-application-curation.service';
import { ListingsService } from '../src/listings/listings.service';
import { NotificationQueryDto } from '../src/notifications/notification.dto';
import { ApplicationActivityService } from '../src/applications/application-activity.service';
import { RealtimeOutboxPublisher } from '../src/realtime/realtime-outbox.publisher';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { OutboxWriter } from '../src/outbox/outbox-writer.service';
import type { OutboxEvent } from '../src/generated/prisma/client';

describe('Durable bell notifications and authorization (PostgreSQL + HTTP + Socket.IO)', () => {
  let c: Awaited<ReturnType<typeof realtimeTestApp>>;
  let now = new Date('2027-01-01T10:00:00Z');
  beforeAll(async () => {
    c = await realtimeTestApp({ clock: () => now, validation: true });
  });
  beforeEach(() => {
    now = new Date('2027-01-01T10:00:00Z');
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await c?.close();
  });
  const inbox = () => c.app.get(NotificationService);
  const commands = () => c.app.get(ViewingWorkflowCommandService);
  const expiry = () => c.app.get(ViewingWorkflowExpiryService);
  const lifecycle = () => c.app.get(ApplicationLifecycleService);
  const curation = () => c.app.get(ProviderApplicationCurationService);
  async function person() {
    const u = await c.user();
    await c.prisma.applicantProfile.create({
      data: {
        applicantId: u.userId,
        householdNetIncome: 5000,
        adultsCount: 1,
        childrenCount: 0,
        peopleCount: 1,
        incomeProofAvailable: true,
        schufaAvailable: true,
        hasPets: false,
        isSmoker: false,
      },
    });
    return u;
  }
  async function fixture() {
    const provider = await c.user('PROVIDER'),
      applicant = await person();
    const listing = await c.prisma.listing.create({
      data: {
        providerId: provider.userId,
        status: 'PUBLISHED',
        displayOrder: 1,
      },
    });
    const app = await c.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: applicant.userId,
        status: 'ACTIVE',
        activeAt: now,
      },
    });
    return { provider, applicant, listing, app };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function body(f: Fixture) {
    return {
      requestKey: randomUUID(),
      expectedWorkflowRevision:
        (
          await c.prisma.viewingWorkflow.findUnique({
            where: { applicationId: f.app.id },
          })
        )?.revision ?? 0,
    };
  }
  function execute(
    f: Fixture,
    side: 'provider' | 'applicant',
    cmd: ViewingWorkflowCommand,
  ) {
    return commands().execute(f.app.id, f[side].userId, side, cmd);
  }
  const schedule = {
    startsAt: '2027-01-03T10:00:00Z',
    endsAt: '2027-01-03T10:30:00Z',
    timeZone: 'Europe/Berlin',
    message: 'PRIVATE SHARED MESSAGE',
  };
  async function invite(f: Fixture) {
    return execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule },
    });
  }
  async function confirm(f: Fixture) {
    const p = await invite(f);
    return execute(f, 'applicant', {
      action: 'accept',
      proposalId: p.proposalId!,
      body: await body(f),
    });
  }
  async function complete(f: Fixture) {
    const a = await confirm(f);
    now = new Date(schedule.endsAt);
    await execute(f, 'provider', {
      action: 'outcome',
      appointmentId: a.appointmentId!,
      body: { ...(await body(f)), outcome: 'COMPLETED' },
    });
    return a.appointmentId!;
  }
  function list(id: string) {
    return inbox().list(id, new NotificationQueryDto());
  }
  function publish(e: OutboxEvent) {
    return c.app.get(RealtimeOutboxPublisher).publish({
      eventId: e.id,
      type: e.type,
      schemaVersion: e.schemaVersion,
      applicationId: e.applicationId,
      conversationId: e.conversationId,
      userId: e.userId,
      occurredAt: e.occurredAt,
      payload: e.payload,
    });
  }
  async function release(f: Fixture) {
    await c.prisma.listingEvent.updateMany({
      where: { applicationId: f.app.id },
      data: { occurredAt: new Date(Date.now() - 3600000) },
    });
  }

  it('persists without sockets, survives a new login, and carries exact safe navigation targets', async () => {
    const f = await fixture(),
      p = await invite(f);
    const fresh = await c.sessionFor(f.applicant.userId);
    const response = await request(c.url)
      .get('/api/v1/me/notifications')
      .set('Cookie', fresh.cookie)
      .expect(200);
    const result = response.body as Awaited<
      ReturnType<NotificationService['list']>
    >;
    expect(result.unreadCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'VIEWING_PROPOSED',
      category: 'VIEWING',
      readAt: null,
      target: {
        applicationId: f.app.id,
        listingId: f.listing.id,
        workflowId: p.workflowId,
        proposalId: p.proposalId,
        appointmentId: null,
        section: 'VIEWING',
        action: 'OPEN_HISTORY',
      },
    });
    expect(result.items[0].target.activityId).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|actorUserId|recipientId|password|providerNote|message|status/,
    );
    expect((await list(f.provider.userId)).items).toEqual([]);
    await request(c.url).get('/api/v1/me/notifications').expect(401);
    await request(c.url)
      .get('/api/v1/me/notifications?limit=0')
      .set('Cookie', fresh.cookie)
      .expect(400);
  });

  it('filters categories before pagination while keeping the global bell count and authorization', async () => {
    const f = await fixture();
    await invite(f);
    await c.app
      .get(ProviderApplicationCurationService)
      .reject(f.app.id, f.provider.userId);
    const session = await c.sessionFor(f.applicant.userId);
    type Page = Awaited<ReturnType<NotificationService['list']>>;
    async function category(value: string) {
      const response = await request(c.url)
        .get(`/api/v1/me/notifications?category=${value}&limit=1`)
        .set('Cookie', session.cookie)
        .expect(200);
      return response.body as Page;
    }
    const viewing = await category('VIEWING'),
      application = await category('APPLICATION'),
      documents = await category('DOCUMENTS');
    expect(viewing.items).toHaveLength(1);
    expect(application.items).toHaveLength(1);
    expect(documents.items).toEqual([]);
    expect(documents.nextCursor).toBeNull();
    expect(viewing.items[0]).toMatchObject({
      category: 'VIEWING',
      target: {
        applicationId: f.app.id,
        listingId: f.listing.id,
        action: 'OPEN_HISTORY',
      },
    });
    expect(application.items[0]).toMatchObject({
      category: 'APPLICATION',
      type: 'APPLICATION_REJECTED',
    });
    for (const page of [viewing, application, documents])
      expect(page.unreadCount).toBe(2);
    expect(viewing.nextCursor).toBeNull(); // Filtering precedes limit+1/cursor calculation.
    expect(viewing.items[0]).not.toHaveProperty('actionable');
    await inbox().markRead(f.applicant.userId, viewing.items[0].id);
    const read = await category('VIEWING');
    expect(read.items[0].readAt).not.toBeNull();
    expect(read.unreadCount).toBe(1);
    const provider = await inbox().list(
      f.provider.userId,
      Object.assign(new NotificationQueryDto(), { category: 'APPLICATION' }),
    );
    expect(provider.items).toEqual([]);
    await request(c.url)
      .get('/api/v1/me/notifications?category=MESSAGES')
      .set('Cookie', session.cookie)
      .expect(400);
  });

  it('connected users see the same durable item and application invalidation; exact replay stays quiet', async () => {
    const f = await fixture(),
      s = c.client(f.applicant.cookie),
      events: unknown[] = [];
    await connected(s);
    s.on('domain-event', (e) => events.push(e));
    const cmd: ViewingWorkflowCommand = {
      action: 'invite',
      body: { ...(await body(f)), ...schedule },
    };
    await execute(f, 'provider', cmd);
    const notification = (await list(f.applicant.userId)).items[0];
    const event = await c.prisma.outboxEvent.findFirstOrThrow({
      where: { applicationId: f.app.id, type: 'application.viewing.changed' },
    });
    await publish(event);
    await quietPeriod();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'application.viewing.changed',
      applicationId: f.app.id,
    });
    await execute(f, 'provider', cmd);
    expect((await list(f.applicant.userId)).items.map((n) => n.id)).toEqual([
      notification.id,
    ]);
    expect(
      await c.prisma.outboxEvent.count({ where: { applicationId: f.app.id } }),
    ).toBe(1);
  });

  it('alternatives/counterproposals/acceptance create one relevant item per response, not technical duplicates', async () => {
    const f = await fixture(),
      p = await invite(f);
    const alt = await execute(f, 'applicant', {
      action: 'alternative-proposal',
      proposalId: p.proposalId!,
      body: {
        ...(await body(f)),
        ...schedule,
        startsAt: '2027-01-04T10:00:00Z',
        endsAt: '2027-01-04T10:30:00Z',
      },
    });
    expect((await list(f.provider.userId)).items.map((n) => n.type)).toEqual([
      'VIEWING_CHANGE_REQUESTED',
    ]);
    const counter = await execute(f, 'provider', {
      action: 'counterproposal',
      proposalId: alt.proposalId!,
      body: { ...(await body(f)), ...schedule },
    });
    expect(
      (await list(f.applicant.userId)).items.map((n) => n.type).sort(),
    ).toEqual(['VIEWING_PROPOSED', 'VIEWING_REPLACEMENT_PROPOSED']);
    await execute(f, 'applicant', {
      action: 'accept',
      proposalId: counter.proposalId!,
      body: await body(f),
    });
    expect(
      (await list(f.provider.userId)).items.map((n) => n.type).sort(),
    ).toEqual(['VIEWING_ACCEPTED', 'VIEWING_CHANGE_REQUESTED']);
  });

  it.each(['applicant', 'provider'] as const)(
    '%s cancellation notifies the other side without copying reasons/notes',
    async (side) => {
      const f = await fixture(),
        a = await confirm(f);
      if (side === 'applicant')
        await execute(f, side, {
          action: 'cancel',
          appointmentId: a.appointmentId!,
          body: { ...(await body(f)), message: 'PRIVATE CANCELLATION' },
        });
      else
        await execute(f, side, {
          action: 'close',
          workflowId: a.workflowId!,
          body: {
            ...(await body(f)),
            appointmentId: a.appointmentId!,
            proposalId: null,
            reason: 'PROVIDER_ILLNESS',
            message: 'PRIVATE PROVIDER NOTE',
          },
        });
      const recipient =
        f[side === 'applicant' ? 'provider' : 'applicant'].userId;
      const rows = (await list(recipient)).items.filter(
        (n) => n.type === 'VIEWING_CANCELLED',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].target.appointmentId).toBe(a.appointmentId);
      expect(JSON.stringify(rows)).not.toMatch(
        /PRIVATE|PROVIDER_ILLNESS|APPLICANT_CANCELLED/,
      );
    },
  );

  it.each(['APPLICANT', 'PROVIDER'] as const)(
    '%s no-show/correction/completion and explicit consideration are visible; undecided is silent',
    async (absenceSide) => {
      const f = await fixture(),
        a = await confirm(f);
      now = new Date(schedule.endsAt);
      await execute(f, 'provider', {
        action: 'outcome',
        appointmentId: a.appointmentId!,
        body: {
          ...(await body(f)),
          outcome: 'NO_SHOW',
          absenceSide,
        },
      });
      expect(
        (await list(f.applicant.userId)).items.some(
          (n) => n.type === 'VIEWING_NO_SHOW',
        ),
      ).toBe(true);
      await execute(f, 'provider', {
        action: 'outcome',
        appointmentId: a.appointmentId!,
        body: {
          ...(await body(f)),
          outcome: 'COMPLETED',
          correctionReason: 'PRIVATE CORRECTION',
        },
      });
      await execute(f, 'provider', {
        action: 'consideration',
        appointmentId: a.appointmentId!,
        body: { ...(await body(f)), consideration: 'UNDECIDED' },
      });
      expect(
        (await list(f.applicant.userId)).items.filter(
          (n) => n.type === 'VIEWING_CONSIDERATION_CHANGED',
        ),
      ).toHaveLength(0);
      await execute(f, 'provider', {
        action: 'consideration',
        appointmentId: a.appointmentId!,
        body: { ...(await body(f)), consideration: 'CONTINUE_CONSIDERING' },
      });
      // Repeated provider confirmation is history, not a second bell interruption.
      await execute(f, 'provider', {
        action: 'consideration',
        appointmentId: a.appointmentId!,
        body: { ...(await body(f)), consideration: 'CONTINUE_CONSIDERING' },
      });
      await execute(f, 'applicant', {
        action: 'interest',
        appointmentId: a.appointmentId!,
        body: { ...(await body(f)), interest: 'STILL_INTERESTED' },
      });
      expect(
        (await list(f.provider.userId)).items.some(
          (n) => n.type === 'VIEWING_INTEREST_CONFIRMED',
        ),
      ).toBe(true);
      await execute(f, 'provider', {
        action: 'consideration',
        appointmentId: a.appointmentId!,
        body: { ...(await body(f)), consideration: 'DO_NOT_CONTINUE' },
      });
      const notifications = (await list(f.applicant.userId)).items;
      expect(
        notifications.filter((n) => n.type === 'APPLICATION_REJECTED'),
      ).toHaveLength(1);
      expect(
        notifications.filter((n) => n.type === 'VIEWING_CONSIDERATION_CHANGED'),
      ).toHaveLength(1);
      expect(
        notifications.some((n) => n.type === 'VIEWING_OUTCOME_CORRECTED'),
      ).toBe(true);
    },
  );

  it('explicit disinterest sends one withdrawal notification and leaves resolved notification history visible', async () => {
    const f = await fixture(),
      id = await complete(f);
    await execute(f, 'applicant', {
      action: 'interest',
      appointmentId: id,
      body: {
        ...(await body(f)),
        interest: 'NOT_INTERESTED',
        confirmWithdrawal: true,
      },
    });
    const rows = (await list(f.provider.userId)).items;
    expect(rows.filter((n) => n.type === 'APPLICATION_WITHDRAWN')).toHaveLength(
      1,
    );
    expect(rows.some((n) => n.type === 'VIEWING_INTEREST_DECLINED')).toBe(
      false,
    );
    expect(
      (await list(f.applicant.userId)).items.some(
        (n) => n.type === 'VIEWING_COMPLETED',
      ),
    ).toBe(true);
  });

  it('expiry retries deduplicate; 48h timeout creates real rejection rather than a second expiry notice', async () => {
    const f = await fixture(),
      p = await invite(f);
    now = new Date('2027-01-01T22:00:00Z');
    const target = {
      applicationId: f.app.id,
      id: p.proposalId!,
      kind: 'proposal' as const,
    };
    await Promise.all([
      expiry().processTarget(target),
      expiry().processTarget(target),
    ]);
    for (const u of [f.applicant, f.provider])
      expect(
        (await list(u.userId)).items.filter(
          (n) => n.type === 'VIEWING_PROPOSAL_EXPIRED',
        ),
      ).toHaveLength(1);
    now = new Date('2027-01-01T10:00:00Z');
    const g = await fixture(),
      id = await complete(g);
    now = new Date(now.getTime() + 48 * 3600000);
    const interest = { applicationId: g.app.id, id, kind: 'interest' as const };
    await Promise.all([
      expiry().processTarget(interest),
      expiry().processTarget(interest),
    ]);
    const rows = (await list(g.applicant.userId)).items;
    expect(rows.filter((n) => n.type === 'APPLICATION_REJECTED')).toHaveLength(
      1,
    );
    expect(rows.some((n) => n.type === 'VIEWING_INTEREST_EXPIRED')).toBe(false);
    expect(
      (await list(g.provider.userId)).items.filter(
        (n) => n.type === 'APPLICATION_REJECTED',
      ),
    ).toHaveLength(1);
  });

  it('WAITING hides provider history/count/read permission and restore/promotion preserves original read state', async () => {
    const f = await fixture();
    await confirm(f);
    const item = (await list(f.provider.userId)).items[0];
    await curation().reject(f.app.id, f.provider.userId);
    await release(f);
    for (let i = 0; i < 5; i++) {
      const u = await person();
      await c.prisma.application.create({
        data: {
          listingId: f.listing.id,
          applicantId: u.userId,
          status: 'ACTIVE',
          activeAt: now,
        },
      });
    }
    await curation().restore(f.app.id, f.provider.userId);
    expect((await list(f.provider.userId)).items).toEqual([]);
    expect((await inbox().unread(f.provider.userId)).unreadCount).toBe(0);
    await expect(
      inbox().markRead(f.provider.userId, item.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await list(f.applicant.userId)).items.some(
        (n) => n.type === 'APPLICATION_RESTORED',
      ),
    ).toBe(true);
    // A genuine lifecycle promotion restores visibility; do not manually change bell rows.
    const active = await c.prisma.application.findFirstOrThrow({
      where: { listingId: f.listing.id, status: 'ACTIVE' },
    });
    await lifecycle().withdraw(active.id, active.applicantId);
    expect(
      (await list(f.provider.userId)).items.find((n) => n.id === item.id)
        ?.readAt,
    ).toBeNull();
  });

  it('read state is durable, scoped, idempotent and invalidates only all tabs of the owner', async () => {
    const f = await fixture();
    await invite(f);
    const item = (await list(f.applicant.userId)).items[0];
    const stranger = await c.user();
    await request(c.url)
      .post(`/api/v1/me/notifications/${item.id}/read`)
      .set('Cookie', stranger.cookie)
      .expect(404);
    const own1 = c.client(f.applicant.cookie),
      own2 = c.client(f.applicant.cookie),
      other = c.client(f.provider.cookie);
    await Promise.all([connected(own1), connected(own2), connected(other)]);
    const a: unknown[] = [],
      b: unknown[] = [],
      hidden: unknown[] = [];
    own1.on('domain-event', (e) => a.push(e));
    own2.on('domain-event', (e) => b.push(e));
    other.on('domain-event', (e) => hidden.push(e));
    await request(c.url)
      .post(`/api/v1/me/notifications/${item.id}/read`)
      .set('Cookie', f.applicant.cookie)
      .expect(200);
    await request(c.url)
      .post(`/api/v1/me/notifications/${item.id}/read`)
      .set('Cookie', f.applicant.cookie)
      .expect(200);
    const events = await c.prisma.outboxEvent.findMany({
      where: { userId: f.applicant.userId, type: 'notifications.changed' },
    });
    expect(events).toHaveLength(1);
    await publish(events[0]);
    await quietPeriod();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(hidden).toEqual([]);
    expect(a[0]).toMatchObject({
      type: 'notifications.changed',
      payload: {},
      userId: f.applicant.userId,
    });
    expect(a[0]).not.toHaveProperty('applicationId');
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(0);
    expect((await list(f.applicant.userId)).items[0].readAt).not.toBeNull();
    // Exercise the real dispatcher/claimed-row path for the new nullable application scope.
    // More than the old five batches of backlog must not determine this test's result.
    await c.prisma.outboxEvent.createMany({
      data: Array.from({ length: 300 }, () => ({
        applicationId: f.app.id,
        type: 'application.lifecycle.changed',
        payload: { listingId: f.listing.id },
        occurredAt: new Date(),
        nextAttemptAt: new Date(0),
      })),
    });
    const oldest = await c.prisma.outboxEvent.aggregate({
      _min: { createdAt: true },
    });
    // Prioritize only our fixture event; leave unrelated rows/backoff untouched.
    await c.prisma.outboxEvent.update({
      where: { id: events[0].id },
      data: {
        createdAt: new Date(
          (oldest._min.createdAt ?? events[0].createdAt).getTime() - 1,
        ),
        nextAttemptAt: new Date(0),
      },
    });
    await c.app.get(OutboxDispatcherService).dispatchOnce();
    expect(
      (
        await c.prisma.outboxEvent.findUniqueOrThrow({
          where: { id: events[0].id },
        })
      ).dispatchedAt,
    ).not.toBeNull();
  });

  it('read-all uses a snapshot and pagination remains stable; hidden/other inbox rows stay untouched', async () => {
    const f = await fixture(),
      p = await invite(f);
    const snapshot = await list(f.applicant.userId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await execute(f, 'applicant', {
      action: 'alternative-proposal',
      proposalId: p.proposalId!,
      body: {
        ...(await body(f)),
        ...schedule,
        startsAt: '2027-01-04T10:00:00Z',
        endsAt: '2027-01-04T10:30:00Z',
      },
    });
    const w = await c.prisma.viewingWorkflow.findUniqueOrThrow({
      where: { applicationId: f.app.id },
    });
    await execute(f, 'provider', {
      action: 'reject',
      proposalId: w.pendingProposalId!,
      body: await body(f),
    });
    await request(c.url)
      .post('/api/v1/me/notifications/read-all')
      .set('Cookie', f.applicant.cookie)
      .send({ throughCreatedAt: snapshot.asOf.toISOString() })
      .expect(200);
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(1);
    expect((await inbox().unread(f.provider.userId)).unreadCount).toBe(1);
    const first = await inbox().list(
      f.applicant.userId,
      Object.assign(new NotificationQueryDto(), { limit: 1 }),
    );
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox().list(
      f.applicant.userId,
      Object.assign(new NotificationQueryDto(), {
        limit: 1,
        beforeId: first.nextCursor!.beforeId,
        beforeCreatedAt: first.nextCursor!.beforeCreatedAt.toISOString(),
      }),
    );
    expect(second.items[0].id).not.toBe(first.items[0].id);
    await request(c.url)
      .get('/api/v1/me/notifications?beforeId=' + randomUUID())
      .set('Cookie', f.applicant.cookie)
      .expect(400);
  });

  it('retains historical notifications after rental; removed ownership never transfers someone else’s inbox', async () => {
    const f = await fixture();
    await confirm(f);
    await c.app
      .get(ListingsService)
      .rentListing(f.listing.id, f.provider.userId, {
        selectedApplicationId: f.app.id,
      });
    expect(
      (await list(f.applicant.userId)).items.some(
        (n) => n.type === 'APPLICATION_ACCEPTED',
      ),
    ).toBe(true);
    const prior = (await list(f.provider.userId)).items[0];
    expect(prior).toBeDefined();
    const owner = await c.user('PROVIDER');
    await c.prisma.listing.update({
      where: { id: f.listing.id },
      data: { providerId: owner.userId },
    });
    expect((await list(f.provider.userId)).items).toEqual([]);
    await expect(
      inbox().markRead(f.provider.userId, prior.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await list(owner.userId)).items).toEqual([]);
  });

  it('notification persistence failure rolls domain/history/outbox back; a retry creates one item', async () => {
    const f = await fixture(),
      producer = c.app.get(NotificationProducer),
      real = producer.activity.bind(producer);
    jest.spyOn(producer, 'activity').mockImplementationOnce(async (...args) => {
      await real(...args);
      throw new Error('notification failure');
    });
    const cmd: ViewingWorkflowCommand = {
      action: 'invite',
      body: { ...(await body(f)), ...schedule },
    };
    await expect(execute(f, 'provider', cmd)).rejects.toThrow(
      'notification failure',
    );
    expect(
      await c.prisma.notification.count({ where: { applicationId: f.app.id } }),
    ).toBe(0);
    expect(
      await c.prisma.applicationActivity.count({
        where: { applicationId: f.app.id },
      }),
    ).toBe(0);
    expect(
      await c.prisma.outboxEvent.count({ where: { applicationId: f.app.id } }),
    ).toBe(0);
    await execute(f, 'provider', cmd);
    expect((await list(f.applicant.userId)).items).toHaveLength(1);
  });

  it('listing archive notifies about a cancelled commitment, not empty technical workflow closure', async () => {
    const f = await fixture();
    const a = await confirm(f);
    await c.app.get(ListingsService).archive(f.listing.id, f.provider.userId);
    const rows = (await list(f.applicant.userId)).items.filter(
      (n) => n.type === 'VIEWING_WORKFLOW_CLOSED',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target.appointmentId).toBe(a.appointmentId);
    expect(
      (await list(f.provider.userId)).items.some(
        (n) => n.type === 'VIEWING_WORKFLOW_CLOSED',
      ),
    ).toBe(false);
  });

  it('read rollback preserves unread state; stable activity identity cannot recreate a read notification', async () => {
    const f = await fixture();
    const p = await invite(f);
    const item = (await list(f.applicant.userId)).items[0];
    const writer = c.app.get(OutboxWriter),
      real = writer.append.bind(writer);
    jest.spyOn(writer, 'append').mockImplementationOnce(async (tx, event) => {
      await real(tx, event);
      throw new Error('read event failure');
    });
    await expect(inbox().markRead(f.applicant.userId, item.id)).rejects.toThrow(
      'read event failure',
    );
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(1);
    expect(
      await c.prisma.outboxEvent.count({
        where: { userId: f.applicant.userId },
      }),
    ).toBe(0);
    await Promise.all([
      inbox().markRead(f.applicant.userId, item.id),
      inbox().markRead(f.applicant.userId, item.id),
    ]);
    await c.prisma.$transaction((tx) =>
      c.app.get(NotificationProducer).activity(tx, item.target.activityId, {
        applicationId: f.app.id,
        type: 'VIEWING_PROPOSED',
        actorType: 'PROVIDER',
        visibility: 'BOTH',
        metadata: { workflowId: p.workflowId!, proposalId: p.proposalId! },
      }),
    );
    expect((await list(f.applicant.userId)).items.map((n) => n.id)).toEqual([
      item.id,
    ]);
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(0);
    expect(
      await c.prisma.outboxEvent.count({
        where: { userId: f.applicant.userId },
      }),
    ).toBe(1);
  });

  it('changed recipient role/status blocks list, count and read; application/activity scope is enforced in PostgreSQL', async () => {
    const f = await fixture();
    await invite(f);
    const item = (await list(f.applicant.userId)).items[0];
    await c.prisma.user.update({
      where: { id: f.applicant.userId },
      data: { status: 'SUSPENDED' },
    });
    expect((await list(f.applicant.userId)).items).toEqual([]);
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(0);
    await expect(
      inbox().markRead(f.applicant.userId, item.id),
    ).rejects.toMatchObject({ status: 404 });
    await c.prisma.user.update({
      where: { id: f.applicant.userId },
      data: { status: 'ACTIVE', role: 'PROVIDER' },
    });
    expect((await list(f.applicant.userId)).items).toEqual([]);
    await c.prisma.user.update({
      where: { id: f.applicant.userId },
      data: { role: 'APPLICANT' },
    });
    expect((await list(f.applicant.userId)).items[0].readAt).toBeNull();
    const other = await fixture();
    await expect(
      c.prisma.notification.create({
        data: {
          recipientId: f.applicant.userId,
          recipientSide: 'APPLICANT',
          applicationId: other.app.id,
          listingId: other.listing.id,
          sourceActivityId: item.target.activityId,
          type: 'VIEWING_PROPOSED',
          section: 'VIEWING',
          occurredAt: now,
        },
      }),
    ).rejects.toThrow();
  });

  it('does not backfill historical activity or expose technical/private events; expired inbox retention leaves Verlauf intact', async () => {
    const f = await fixture();
    await c.prisma.applicationActivity.create({
      data: {
        applicationId: f.app.id,
        type: 'VIEWING_PROPOSED',
        actorType: 'PROVIDER',
        visibility: 'BOTH',
      },
    });
    expect((await list(f.applicant.userId)).items).toEqual([]);
    await c.app.get(ApplicationActivityService).append({
      applicationId: f.app.id,
      type: 'VIEWING_PROPOSED',
      actorType: 'PROVIDER',
      visibility: 'INTERNAL',
    });
    expect((await list(f.applicant.userId)).items).toEqual([]);
    await invite(f);
    const item = (await list(f.applicant.userId)).items[0];
    await c.prisma.notification.update({
      where: { id: item.id },
      data: {
        createdAt: new Date(Date.now() - 91 * 86400000),
        expiresAt: new Date(Date.now() - 86400000),
      },
    });
    expect((await inbox().unread(f.applicant.userId)).unreadCount).toBe(0);
    expect((await list(f.applicant.userId)).items).toEqual([]);
    expect(
      await c.app.get(NotificationRetention).purgeExpired(),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await c.prisma.applicationActivity.findUnique({
        where: { id: item.target.activityId },
      }),
    ).not.toBeNull();
  });
});
