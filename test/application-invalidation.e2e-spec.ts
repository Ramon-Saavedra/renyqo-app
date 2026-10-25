import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { connected, quietPeriod, realtimeTestApp } from './realtime-test-app';
import { Role } from '../src/generated/prisma/enums';
import {
  ViewingWorkflowCommandService,
  type ViewingWorkflowCommand,
} from '../src/application-viewings/viewing-workflow-command.service';
import { ProviderApplicationCurationService } from '../src/applications/provider-application-curation.service';
import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ApplicationAttentionQueryService } from '../src/application-attention/application-attention-query.service';
import { ListingsService } from '../src/listings/listings.service';
import { OutboxWriter } from '../src/outbox/outbox-writer.service';
import { RealtimeOutboxPublisher } from '../src/realtime/realtime-outbox.publisher';
import { RealtimeEventRouter } from '../src/realtime/realtime-event-router.service';
import type { OutboxEvent } from '../src/generated/prisma/client';

const VIEWING = 'application.viewing.changed',
  LIFECYCLE = 'application.lifecycle.changed';
describe('Viewing/lifecycle transactional invalidation and Socket.IO', () => {
  let context: Awaited<ReturnType<typeof realtimeTestApp>>;
  let now = new Date('2027-01-01T10:00:00Z');
  beforeAll(async () => {
    context = await realtimeTestApp({ clock: () => now });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(() => {
    now = new Date('2027-01-01T10:00:00Z');
  });
  async function person() {
    const user = await context.user();
    await context.prisma.applicantProfile.create({
      data: {
        applicantId: user.userId,
        householdNetIncome: 5000,
        incomeProofAvailable: true,
        schufaAvailable: true,
        adultsCount: 1,
        childrenCount: 0,
        peopleCount: 1,
        hasPets: false,
        isSmoker: false,
      },
    });
    return user;
  }
  async function fixture() {
    const provider = await context.user(Role.PROVIDER),
      applicant = await person();
    const listing = await context.prisma.listing.create({
      data: {
        providerId: provider.userId,
        displayOrder: 1,
        status: 'PUBLISHED',
      },
    });
    const application = await context.prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: applicant.userId,
        status: 'ACTIVE',
        activeAt: now,
      },
    });
    return { provider, applicant, listing, application };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const commands = () => context.app.get(ViewingWorkflowCommandService);
  const curation = () => context.app.get(ProviderApplicationCurationService);
  const schedule = () => ({
    startsAt: '2027-01-03T10:00:00.000Z',
    endsAt: '2027-01-03T10:30:00.000Z',
    timeZone: 'Europe/Berlin',
    message: 'PRIVATE PROPOSAL MESSAGE',
  });
  const alternative = () => ({
    ...schedule(),
    startsAt: '2027-01-04T10:00:00.000Z',
    endsAt: '2027-01-04T10:30:00.000Z',
  });
  async function body(f: Fixture) {
    return {
      expectedWorkflowRevision:
        (
          await context.prisma.viewingWorkflow.findUnique({
            where: { applicationId: f.application.id },
          })
        )?.revision ?? 0,
      requestKey: randomUUID(),
    };
  }
  async function execute(
    f: Fixture,
    side: 'provider' | 'applicant',
    command: ViewingWorkflowCommand,
  ) {
    const before = await context.prisma.outboxEvent.findMany({
      where: { applicationId: f.application.id },
      select: { id: true },
    });
    const result = await commands().execute(
      f.application.id,
      side === 'provider' ? f.provider.userId : f.applicant.userId,
      side,
      command,
    );
    const rows = await context.prisma.outboxEvent.findMany({
      where: {
        applicationId: f.application.id,
        type: VIEWING,
        id: { notIn: before.map((e) => e.id) },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: null,
      schemaVersion: 1,
      payload: {
        listingId: f.listing.id,
        workflowId: result.workflowId,
        workflowRevision: result.workflowRevision,
      },
    });
    expect(JSON.stringify(rows[0].payload)).not.toMatch(
      /PRIVATE|message|status|badge|count|startsAt|applicantId/,
    );
    return { ...result, event: rows[0] };
  }
  async function confirm(f: Fixture) {
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    return execute(f, 'applicant', {
      action: 'accept',
      proposalId: invitation.proposalId!,
      body: await body(f),
    });
  }
  async function release(f: Fixture) {
    await context.prisma.listingEvent.updateMany({
      where: { applicationId: f.application.id },
      data: { occurredAt: new Date(Date.now() - 3600000) },
    });
  }
  function publish(event: OutboxEvent) {
    return context.app.get(RealtimeOutboxPublisher).publish({
      eventId: event.id,
      type: event.type,
      schemaVersion: event.schemaVersion,
      applicationId: event.applicationId,
      conversationId: event.conversationId,
      occurredAt: event.occurredAt,
      payload: event.payload,
    });
  }
  async function lifecycleEvent(f: Fixture) {
    return context.prisma.outboxEvent.findFirstOrThrow({
      where: { applicationId: f.application.id, type: LIFECYCLE },
      orderBy: { createdAt: 'desc' },
    });
  }

  it('invalidates every negotiation step and coalesces atomic replacements; exact replay is quiet', async () => {
    const f = await fixture();
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    const a = await execute(f, 'applicant', {
      action: 'alternative-proposal',
      proposalId: invitation.proposalId!,
      body: { ...(await body(f)), ...alternative() },
    });
    const counter = await execute(f, 'provider', {
      action: 'counterproposal',
      proposalId: a.proposalId!,
      body: { ...(await body(f)), ...schedule() },
    });
    const accepted = await execute(f, 'applicant', {
      action: 'accept',
      proposalId: counter.proposalId!,
      body: await body(f),
    });
    const replacement = await execute(f, 'provider', {
      action: 'replacement',
      appointmentId: accepted.appointmentId!,
      body: { ...(await body(f)), ...alternative() },
    });
    await execute(f, 'applicant', {
      action: 'reject',
      proposalId: replacement.proposalId!,
      body: await body(f),
    });
    const own = await execute(f, 'applicant', {
      action: 'alternative-appointment',
      appointmentId: accepted.appointmentId!,
      body: { ...(await body(f)), ...alternative() },
    });
    await execute(f, 'applicant', {
      action: 'withdraw',
      proposalId: own.proposalId!,
      body: await body(f),
    });
    const next = await execute(f, 'provider', {
      action: 'replacement',
      appointmentId: accepted.appointmentId!,
      body: { ...(await body(f)), ...alternative() },
    });
    const accept: ViewingWorkflowCommand = {
      action: 'accept',
      proposalId: next.proposalId!,
      body: await body(f),
    };
    const result = await execute(f, 'applicant', accept);
    const count = await context.prisma.outboxEvent.count({
      where: { applicationId: f.application.id },
    });
    expect(
      await commands().execute(
        f.application.id,
        f.applicant.userId,
        'applicant',
        accept,
      ),
    ).toMatchObject({ workflowRevision: result.workflowRevision });
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(count);
    await execute(f, 'applicant', {
      action: 'cancel',
      appointmentId: result.appointmentId!,
      body: await body(f),
    });
    const declined = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    await execute(f, 'applicant', {
      action: 'reject',
      proposalId: declined.proposalId!,
      body: await body(f),
    });
    const last = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    await execute(f, 'provider', {
      action: 'close',
      workflowId: last.workflowId!,
      body: {
        ...(await body(f)),
        proposalId: last.proposalId,
        appointmentId: null,
        reason: 'PROVIDER_OPERATIONAL',
      },
    });
  });
  it('records attendance, no-show priority, correction, interest and provider decisions in their domain transactions', async () => {
    const f = await fixture(),
      confirmed = await confirm(f);
    const before =
      await context.prisma.applicationConsiderationPosition.findUniqueOrThrow({
        where: { applicationId: f.application.id },
      });
    now = new Date('2027-01-03T10:30:00Z');
    await execute(f, 'provider', {
      action: 'outcome',
      appointmentId: confirmed.appointmentId!,
      body: {
        ...(await body(f)),
        outcome: 'NO_SHOW',
        absenceSide: 'APPLICANT',
      },
    });
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: f.application.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      (
        await context.prisma.applicationConsiderationPosition.findUniqueOrThrow(
          { where: { applicationId: f.application.id } },
        )
      ).position,
    ).toBeGreaterThan(before.position);
    await execute(f, 'provider', {
      action: 'outcome',
      appointmentId: confirmed.appointmentId!,
      body: {
        ...(await body(f)),
        outcome: 'COMPLETED',
        correctionReason: 'PRIVATE CORRECTION',
      },
    });
    await execute(f, 'applicant', {
      action: 'interest',
      appointmentId: confirmed.appointmentId!,
      body: { ...(await body(f)), interest: 'STILL_INTERESTED' },
    });
    await execute(f, 'provider', {
      action: 'consideration',
      appointmentId: confirmed.appointmentId!,
      body: { ...(await body(f)), consideration: 'UNDECIDED' },
    });
    await execute(f, 'provider', {
      action: 'consideration',
      appointmentId: confirmed.appointmentId!,
      body: { ...(await body(f)), consideration: 'DO_NOT_CONTINUE' },
    });
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: f.application.id },
        })
      ).publicReason,
    ).toBe('NOT_SELECTED');
    expect(await lifecycleEvent(f)).toMatchObject({
      conversationId: null,
      payload: { listingId: f.listing.id },
    });
  });
  it('rolls back domain, history, receipt and outbox if the transactional producer fails', async () => {
    const f = await fixture(),
      writer = context.app.get(OutboxWriter),
      original = writer.append.bind(writer);
    jest.spyOn(writer, 'append').mockImplementation(async (tx, input) => {
      await original(tx, input);
      throw new Error('forced outbox rollback');
    });
    await expect(
      commands().execute(f.application.id, f.provider.userId, 'provider', {
        action: 'invite',
        body: { ...(await body(f)), ...schedule() },
      }),
    ).rejects.toThrow('forced outbox rollback');
    expect(
      await context.prisma.viewingWorkflow.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await context.prisma.applicationActivity.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await context.prisma.viewingCommandReceipt.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(0);
  });
  it('rolls back lifecycle and already-written viewing invalidation together', async () => {
    const f = await fixture();
    await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    const before = await context.prisma.outboxEvent.count({
      where: { applicationId: f.application.id },
    });
    const writer = context.app.get(OutboxWriter),
      original = writer.append.bind(writer);
    jest.spyOn(writer, 'append').mockImplementation(async (tx, input) => {
      const row = await original(tx, input);
      if (input.type === LIFECYCLE)
        throw new Error('forced lifecycle rollback');
      return row;
    });
    await expect(
      curation().reject(f.application.id, f.provider.userId),
    ).rejects.toThrow('forced lifecycle rollback');
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: f.application.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      (
        await context.prisma.viewingWorkflow.findUniqueOrThrow({
          where: { applicationId: f.application.id },
        })
      ).pendingProposalId,
    ).not.toBeNull();
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: f.application.id },
      }),
    ).toBe(before);
  });
  it('delivers minimal invalidation to all authorized tabs; duplicates retain eventId and strangers get nothing', async () => {
    const f = await fixture(),
      foreign = await context.user(Role.PROVIDER);
    const sockets = [
      context.client(f.provider.cookie),
      context.client(f.provider.cookie),
      context.client(f.applicant.cookie),
      context.client(f.applicant.cookie),
      context.client(foreign.cookie),
    ];
    const received: unknown[][] = sockets.map(() => []);
    sockets.forEach((s, i) =>
      s.on('domain-event', (e: unknown) => received[i].push(e)),
    );
    await Promise.all(sockets.map((s) => connected(s)));
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    await publish(invitation.event);
    await publish(invitation.event);
    await quietPeriod();
    for (const rows of received.slice(0, 4)) {
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[0]).toMatchObject({
        eventId: invitation.event.id,
        type: VIEWING,
        applicationId: f.application.id,
      });
      expect(rows[0]).not.toHaveProperty('conversationId');
    }
    expect(received[4]).toEqual([]);
    for (const rows of received) rows.length = 0;
    await curation().reject(f.application.id, f.provider.userId);
    await publish(await lifecycleEvent(f));
    await quietPeriod();
    for (const rows of received.slice(0, 4)) expect(rows).toHaveLength(1);
    expect(received[4]).toEqual([]);
    for (const socket of sockets) socket.disconnect();
  });
  it('preserves unread/reply state across real reject/restore while lifecycle hints refresh both owners', async () => {
    const f = await fixture();
    const conversation = await context.prisma.applicationConversation.create({
      data: { applicationId: f.application.id, applicantRepliesEnabled: true },
    });
    const message = await context.prisma.applicationMessage.create({
      data: {
        conversationId: conversation.id,
        sequence: 1,
        senderType: 'APPLICANT',
        body: 'PRIVATE UNREAD MESSAGE',
      },
    });
    const attention = context.app.get(ApplicationAttentionQueryService);
    expect(
      (await attention.detail(f.provider.userId, 'provider', f.application.id))
        .actionableUnreadMessageCount,
    ).toBe(1);
    await curation().reject(f.application.id, f.provider.userId);
    expect(
      (await attention.detail(f.provider.userId, 'provider', f.application.id))
        .actionableUnreadMessageCount,
    ).toBe(0);
    const rejected = await lifecycleEvent(f);
    await release(f);
    await curation().restore(f.application.id, f.provider.userId);
    expect(
      (await attention.detail(f.provider.userId, 'provider', f.application.id))
        .actionableUnreadMessageCount,
    ).toBe(1);
    expect(
      (
        await context.prisma.applicationMessage.findUniqueOrThrow({
          where: { id: message.id },
        })
      ).readAt,
    ).toBeNull();
    expect(
      (
        await context.prisma.applicationConversation.findUniqueOrThrow({
          where: { id: conversation.id },
        })
      ).applicantRepliesEnabled,
    ).toBe(true);
    const socket = context.client(f.provider.cookie),
      received: unknown[] = [];
    socket.on('domain-event', (e: unknown) => received.push(e));
    await connected(socket);
    const restored = await lifecycleEvent(f);
    await publish(rejected);
    await publish(restored);
    await quietPeriod();
    expect(received).toHaveLength(2);
    expect(JSON.stringify(received)).not.toContain('PRIVATE');
    socket.disconnect();
  });
  it('redacts delayed events after WAITING restore and rechecks visibility after initial recipient lookup', async () => {
    const f = await fixture();
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    const sockets = [
        context.client(f.provider.cookie),
        context.client(f.applicant.cookie),
      ],
      received: unknown[][] = [[], []];
    sockets.forEach((s, i) =>
      s.on('domain-event', (e: unknown) => received[i].push(e)),
    );
    await Promise.all(sockets.map((s) => connected(s)));
    await curation().reject(f.application.id, f.provider.userId);
    await release(f);
    for (let index = 0; index < 5; index++) {
      const user = await person();
      await context.prisma.application.create({
        data: {
          listingId: f.listing.id,
          applicantId: user.userId,
          status: 'ACTIVE',
          activeAt: now,
        },
      });
    }
    await curation().restore(f.application.id, f.provider.userId);
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: f.application.id },
        })
      ).status,
    ).toBe('WAITING');
    await publish(invitation.event);
    await quietPeriod();
    expect(received[0]).toEqual([
      {
        eventId: invitation.event.id,
        type: 'listing.applications.changed',
        schemaVersion: 1,
        occurredAt: invitation.event.occurredAt.toISOString(),
        listingId: f.listing.id,
        payload: {},
      },
    ]);
    expect(received[1][0]).toMatchObject({
      applicationId: f.application.id,
      type: VIEWING,
    });
    // Simulate loss of access during session validation, after the first routing lookup.
    const other = await context.prisma.application.findFirstOrThrow({
      where: { listingId: f.listing.id, status: 'ACTIVE' },
    });
    await context.prisma.application.update({
      where: { id: other.id },
      data: { status: 'WITHDRAWN' },
    });
    await context.prisma.application.update({
      where: { id: f.application.id },
      data: { status: 'ACTIVE' },
    });
    const router = context.app.get(RealtimeEventRouter),
      routes = router.routes.bind(router);
    let lookups = 0;
    jest.spyOn(router, 'routes').mockImplementation(async (event) => {
      lookups++;
      if (lookups === 2)
        await context.prisma.application.update({
          where: { id: f.application.id },
          data: { status: 'WAITING' },
        });
      return routes(event);
    });
    received[0].length = 0;
    await publish(invitation.event);
    await quietPeriod();
    expect(received[0][0]).toMatchObject({
      type: 'listing.applications.changed',
    });
    expect(received[0][0]).not.toHaveProperty('applicationId');
    for (const socket of sockets) socket.disconnect();
  });
  it('invalidates promotion, withdrawal, rental selection and historical applications on archive without needing viewings', async () => {
    const f = await fixture(),
      waiting = await person();
    const candidate = await context.prisma.application.create({
      data: {
        listingId: f.listing.id,
        applicantId: waiting.userId,
        status: 'WAITING',
      },
    });
    await context.app
      .get(ApplicationLifecycleService)
      .withdraw(f.application.id, f.applicant.userId);
    expect(await lifecycleEvent(f)).toBeDefined();
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: candidate.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: candidate.id, type: LIFECYCLE },
      }),
    ).toBe(1);
    await context.app
      .get(ListingsService)
      .rentListing(f.listing.id, f.provider.userId, {
        selectedApplicationId: candidate.id,
      });
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: candidate.id },
        })
      ).status,
    ).toBe('ACCEPTED');
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: candidate.id, type: LIFECYCLE },
      }),
    ).toBe(2);
    const archive = await fixture();
    await context.app
      .get(ListingsService)
      .archive(archive.listing.id, archive.provider.userId);
    expect(await lifecycleEvent(archive)).toMatchObject({
      payload: { listingId: archive.listing.id },
    });
    const socket = context.client(f.provider.cookie),
      events: unknown[] = [];
    socket.on('domain-event', (e: unknown) => events.push(e));
    await connected(socket);
    await publish(await lifecycleEvent(f));
    await quietPeriod();
    expect(events[0]).toMatchObject({
      type: LIFECYCLE,
      applicationId: f.application.id,
    });
    socket.disconnect();
  });
  it('resolves current listing ownership at delivery and gives no event to the former owner', async () => {
    const f = await fixture(),
      newOwner = await context.user(Role.PROVIDER);
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    const oldSocket = context.client(f.provider.cookie),
      newSocket = context.client(newOwner.cookie),
      old: unknown[] = [],
      current: unknown[] = [];
    oldSocket.on('domain-event', (e: unknown) => old.push(e));
    newSocket.on('domain-event', (e: unknown) => current.push(e));
    await Promise.all([connected(oldSocket), connected(newSocket)]);
    await context.prisma.listing.update({
      where: { id: f.listing.id },
      data: { providerId: newOwner.userId },
    });
    await publish(invitation.event);
    await quietPeriod();
    expect(old).toEqual([]);
    expect(current[0]).toMatchObject({ applicationId: f.application.id });
    oldSocket.disconnect();
    newSocket.disconnect();
  });
  it('enforces nullable-conversation scope, deduplication and existing conversation constraints in PostgreSQL', async () => {
    const f = await fixture();
    await expect(
      context.prisma.outboxEvent.create({
        data: {
          type: VIEWING,
          applicationId: f.application.id,
          conversationId: randomUUID(),
          occurredAt: now,
          payload: { listingId: f.listing.id },
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      context.prisma.outboxEvent.create({
        data: {
          type: 'conversation.message.created',
          applicationId: f.application.id,
          conversationId: null,
          occurredAt: now,
          payload: {},
        },
      }),
    ).rejects.toBeDefined();
    const invitation = await execute(f, 'provider', {
      action: 'invite',
      body: { ...(await body(f)), ...schedule() },
    });
    await expect(
      context.prisma.outboxEvent.create({
        data: {
          type: VIEWING,
          applicationId: f.application.id,
          conversationId: null,
          deduplicationKey: invitation.event.deduplicationKey,
          occurredAt: now,
          payload: { listingId: f.listing.id },
        },
      }),
    ).rejects.toBeDefined();
  });
});
