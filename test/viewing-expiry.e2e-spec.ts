import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { realtimeTestApp, connected } from './realtime-test-app';
import {
  ViewingWorkflowCommandService,
  type ViewingWorkflowCommand,
} from '../src/application-viewings/viewing-workflow-command.service';
import {
  ViewingWorkflowExpiryService,
  type ViewingExpiryTarget,
} from '../src/application-viewings/viewing-workflow-expiry.service';
import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ProviderApplicationCurationService } from '../src/applications/provider-application-curation.service';
import { ListingsService } from '../src/listings/listings.service';
import { OutboxWriter } from '../src/outbox/outbox-writer.service';
import { RealtimeOutboxPublisher } from '../src/realtime/realtime-outbox.publisher';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { ApplicationActivityService } from '../src/applications/application-activity.service';

describe('Durable viewing expiry, time boundaries and races (PostgreSQL)', () => {
  let context: Awaited<ReturnType<typeof realtimeTestApp>>;
  let now = new Date('2027-01-01T10:00:00Z');
  beforeAll(async () => {
    context = await realtimeTestApp({ clock: () => now });
  });
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(() => {
    now = new Date('2027-01-01T10:00:00Z');
  });
  afterEach(() => jest.restoreAllMocks());
  const expiry = () => context.app.get(ViewingWorkflowExpiryService);
  const commands = () => context.app.get(ViewingWorkflowCommandService);
  const lifecycle = () => context.app.get(ApplicationLifecycleService);
  const curation = () => context.app.get(ProviderApplicationCurationService);
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
    const provider = await context.user('PROVIDER'),
      applicant = await person();
    const listing = await context.prisma.listing.create({
      data: {
        providerId: provider.userId,
        displayOrder: 1,
        status: 'PUBLISHED',
      },
    });
    const app = await context.prisma.application.create({
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
          await context.prisma.viewingWorkflow.findUnique({
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
  async function invite(f: Fixture, short = false) {
    return execute(f, 'provider', {
      action: 'invite',
      body: {
        ...(await body(f)),
        startsAt: short ? '2027-01-01T12:00:00Z' : '2027-01-03T10:00:00Z',
        endsAt: short ? '2027-01-01T12:30:00Z' : '2027-01-03T10:30:00Z',
        timeZone: 'Europe/Berlin',
        shortNotice: short,
      },
    });
  }
  async function complete(f: Fixture) {
    const p = await invite(f);
    const accepted = await execute(f, 'applicant', {
      action: 'accept',
      proposalId: p.proposalId!,
      body: await body(f),
    });
    now = new Date('2027-01-03T10:30:00Z');
    await execute(f, 'provider', {
      action: 'outcome',
      appointmentId: accepted.appointmentId!,
      body: { ...(await body(f)), outcome: 'COMPLETED' },
    });
    return accepted.appointmentId!;
  }
  const target = (
    f: Fixture,
    id: string,
    kind: 'proposal' | 'interest' = 'proposal',
  ): ViewingExpiryTarget => ({ applicationId: f.app.id, id, kind });
  async function app(f: Fixture) {
    return context.prisma.application.findUniqueOrThrow({
      where: { id: f.app.id },
    });
  }
  async function history(
    f: Fixture,
    type: 'VIEWING_PROPOSAL_EXPIRED' | 'VIEWING_INTEREST_EXPIRED',
  ) {
    return context.prisma.applicationActivity.findMany({
      where: { applicationId: f.app.id, type },
    });
  }
  async function interestDeadline(id: string) {
    return (
      await context.prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      })
    ).interestDeadlineAt!;
  }

  it('recovers overdue rows in bounded batches and duplicate executions are quiet', async () => {
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    await Promise.all(fixtures.map((f) => invite(f)));
    now = new Date('2027-01-01T22:00:00Z');
    const writer = context.app.get(OutboxWriter),
      real = writer.append.bind(writer);
    jest.spyOn(writer, 'append').mockImplementationOnce(async (tx, event) => {
      await real(tx, event);
      throw new Error('transient worker failure');
    });
    expect(await expiry().runOnce(2)).toEqual({
      scanned: 2,
      processed: 1,
      failed: 1,
    });
    expect(await expiry().runOnce(2)).toEqual({
      scanned: 1,
      processed: 1,
      failed: 0,
    });
    expect(await expiry().runOnce(2)).toEqual({
      scanned: 1,
      processed: 1,
      failed: 0,
    });
    expect(await expiry().runOnce(2)).toEqual({
      scanned: 0,
      processed: 0,
      failed: 0,
    });
    for (const f of fixtures) {
      expect((await app(f)).status).toBe('ACTIVE');
      expect(await history(f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(1);
    }
  });

  it('advances past a poisoned full first batch, retries failed/no-op rows, and stays safe with two worker instances', async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const f = await fixture(),
        p = await invite(f);
      rows.push({ f, id: p.proposalId! });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const [poison, blocked, ...healthy] = rows;
    now = new Date('2027-01-01T22:00:00Z');
    const worker = expiry(),
      other = new ViewingWorkflowExpiryService(
        context.prisma,
        context.app.get(ViewingClock),
        context.app.get(ApplicationActivityService),
        lifecycle(),
      );
    const writer = context.app.get(OutboxWriter),
      realWrite = writer.append.bind(writer);
    let failedAttempts = 0,
      blockedAttempts = 0;
    jest.spyOn(writer, 'append').mockImplementation((tx, event) => {
      if (event.applicationId === poison.f.app.id) {
        failedAttempts++;
        return Promise.reject(new Error('persistent poison'));
      }
      return realWrite(tx, event);
    });
    for (const instance of [worker, other]) {
      const real = instance.processTarget.bind(instance);
      jest.spyOn(instance, 'processTarget').mockImplementation((t) => {
        if (t.id === blocked.id) {
          blockedAttempts++;
          return Promise.resolve(false);
        }
        return real(t);
      });
    }
    // More due targets than the batch; neither of the first two can progress.
    expect(await worker.runOnce(2)).toEqual({
      scanned: 2,
      processed: 0,
      failed: 1,
    });
    await other.runOnce(2);
    for (let i = 0; i < 4; i++)
      await Promise.all([worker.runOnce(2), other.runOnce(2)]);
    for (const row of healthy) {
      expect(await history(row.f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(1);
      expect(
        await context.prisma.outboxEvent.count({
          where: {
            applicationId: row.f.app.id,
            type: 'application.viewing.changed',
          },
        }),
      ).toBe(2);
    }
    expect(failedAttempts).toBeGreaterThan(1);
    expect(blockedAttempts).toBeGreaterThan(1);
    for (const row of [poison, blocked]) {
      expect(
        await context.prisma.viewingProposal.findUniqueOrThrow({
          where: { id: row.id },
        }),
      ).toMatchObject({ resolution: 'PENDING', responseDeadlineAt: now });
      expect(await history(row.f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(0);
    }
    jest.restoreAllMocks();
    // Restart loses only the optimization cursor: durable due rows are rediscovered.
    const restarted = new ViewingWorkflowExpiryService(
      context.prisma,
      context.app.get(ViewingClock),
      context.app.get(ApplicationActivityService),
      lifecycle(),
    );
    const results = await Promise.all([
      restarted.runOnce(2),
      restarted.runOnce(2),
    ]);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(2);
    for (const row of [poison, blocked])
      expect(await history(row.f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(1);
  });

  it.each(['worker', 'command'] as const)(
    'expires 48h interest after PROVIDER_CLOSED via %s, preserving closure and promoting once',
    async (mode) => {
      const f = await fixture(),
        id = await complete(f);
      const p = await execute(f, 'provider', {
        action: 'invite',
        body: {
          ...(await body(f)),
          startsAt: '2027-01-04T10:00:00Z',
          endsAt: '2027-01-04T10:30:00Z',
          timeZone: 'Europe/Berlin',
        },
      });
      await execute(f, 'provider', {
        action: 'close',
        workflowId: p.workflowId!,
        body: {
          ...(await body(f)),
          proposalId: p.proposalId!,
          appointmentId: null,
          reason: 'PROVIDER_OPERATIONAL',
        },
      });
      const closed = await context.prisma.viewingWorkflow.findUniqueOrThrow({
        where: { applicationId: f.app.id },
      });
      expect(closed).toMatchObject({
        state: 'CLOSED',
        closureReason: 'PROVIDER_CLOSED',
      });
      for (let i = 0; i < 4; i++) {
        const u = await person();
        await context.prisma.application.create({
          data: {
            listingId: f.listing.id,
            applicantId: u.userId,
            status: 'ACTIVE',
            activeAt: now,
          },
        });
      }
      const waiting = [];
      for (let i = 0; i < 2; i++) {
        const u = await person();
        waiting.push(
          await context.prisma.application.create({
            data: {
              listingId: f.listing.id,
              applicantId: u.userId,
              status: 'WAITING',
              queueOrder: i + 1,
            },
          }),
        );
      }
      const before = await context.prisma.outboxEvent.findMany({
        where: { applicationId: f.app.id },
        select: { id: true },
      });
      const deadline = await interestDeadline(id);
      now = new Date(deadline.getTime() - 1);
      expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(
        false,
      );
      now = deadline;
      const projection = await commands().snapshot(
        f.app.id,
        f.applicant.userId,
        'applicant',
      );
      expect(projection.applicantInterest?.state).toBe('EXPIRED');
      expect(projection.obligations).toEqual([]);
      if (mode === 'worker') await expiry().runOnce(500);
      else
        await expect(
          execute(f, 'applicant', {
            action: 'interest',
            appointmentId: id,
            body: { ...(await body(f)), interest: 'STILL_INTERESTED' },
          }),
        ).rejects.toMatchObject({
          response: { reason: 'INTEREST_RESPONSE_EXPIRED' },
        });
      expect(await app(f)).toMatchObject({
        status: 'REJECTED',
        publicReason: 'POST_VIEWING_RESPONSE_EXPIRED',
        withdrawnAt: null,
      });
      const after = await context.prisma.viewingWorkflow.findUniqueOrThrow({
        where: { applicationId: f.app.id },
      });
      expect(after).toMatchObject({
        closedAt: closed.closedAt,
        closureReason: closed.closureReason,
        revision: closed.revision + 1,
      });
      expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toMatchObject([
        { actorType: 'SYSTEM', actorUserId: null },
      ]);
      expect(
        await context.prisma.applicationActivity.count({
          where: { applicationId: f.app.id, type: 'VIEWING_WORKFLOW_CLOSED' },
        }),
      ).toBe(0);
      expect(
        (
          await context.prisma.application.findUniqueOrThrow({
            where: { id: waiting[0].id },
          })
        ).status,
      ).toBe('ACTIVE');
      expect(
        (
          await context.prisma.application.findUniqueOrThrow({
            where: { id: waiting[1].id },
          })
        ).status,
      ).toBe('WAITING');
      expect(
        await context.prisma.application.count({
          where: { listingId: f.listing.id, status: 'ACTIVE' },
        }),
      ).toBe(5);
      const events = await context.prisma.outboxEvent.findMany({
        where: {
          applicationId: f.app.id,
          id: { notIn: before.map((e) => e.id) },
        },
      });
      expect(events.map((e) => e.type).sort()).toEqual([
        'application.lifecycle.changed',
        'application.viewing.changed',
      ]);
      const viewing = events.find(
        (e) => e.type === 'application.viewing.changed',
      );
      expect(viewing?.payload).toMatchObject({
        workflowRevision: after.revision,
      });
      await Promise.all([
        expiry().processTarget(target(f, id, 'interest')),
        expiry().processTarget(target(f, id, 'interest')),
      ]);
      expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toHaveLength(1);
      expect(
        await context.prisma.outboxEvent.count({
          where: { applicationId: f.app.id },
        }),
      ).toBe(before.length + 2);
      expect(
        await context.prisma.applicationActivity.count({
          where: {
            applicationId: waiting[0].id,
            type: 'APPLICATION_PROMOTED_TO_ACTIVE',
          },
        }),
      ).toBe(1);
      expect(
        await context.prisma.outboxEvent.count({
          where: {
            applicationId: waiting[0].id,
            type: 'application.lifecycle.changed',
          },
        }),
      ).toBe(1);
    },
  );

  it.each([false, true])(
    'enforces the exact authoritative invitation deadline (short notice: %s)',
    async (short) => {
      const f = await fixture(),
        p = await invite(f, short);
      const stored = await context.prisma.viewingProposal.findUniqueOrThrow({
        where: { id: p.proposalId! },
      });
      expect(stored.responseDeadlineAt).toEqual(
        new Date(short ? '2027-01-01T12:00:00Z' : '2027-01-01T22:00:00Z'),
      );
      now = new Date(stored.responseDeadlineAt!.getTime() - 1);
      expect(await expiry().processTarget(target(f, p.proposalId!))).toBe(
        false,
      );
      const snapshot = await commands().snapshot(
        f.app.id,
        f.applicant.userId,
        'applicant',
      );
      expect(
        snapshot.capabilities.find((c) => c.action === 'ACCEPT_PROPOSAL')
          ?.allowed,
      ).toBe(true);
      now = stored.responseDeadlineAt!;
      const expired = await commands().snapshot(
        f.app.id,
        f.applicant.userId,
        'applicant',
      );
      expect(expired.pendingProposal?.effectiveResolution).toBe('EXPIRED');
      expect(
        expired.obligations.some(
          (o) => o.action === 'APPLICANT_RESPOND_TO_VIEWING',
        ),
      ).toBe(false);
      const input: ViewingWorkflowCommand = {
        action: 'accept',
        proposalId: p.proposalId!,
        body: await body(f),
      };
      await Promise.allSettled([
        expiry().processTarget(target(f, p.proposalId!)),
        execute(f, 'applicant', input),
      ]);
      expect(await history(f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(1);
      expect(
        await context.prisma.viewingAppointment.count({
          where: { workflowId: p.workflowId! },
        }),
      ).toBe(0);
      await expect(execute(f, 'applicant', input)).rejects.toMatchObject({
        response: { code: 'VIEWING_STATE_CHANGED' },
      });
      // Provider can issue another invitation once the expired pointer is durably cleared.
      now = new Date('2027-01-02T10:00:00Z');
      await invite(f);
      expect((await app(f)).status).toBe('ACTIVE');
    },
  );

  it('acceptance one millisecond before expiry wins; subsequent expiry is a no-op', async () => {
    const f = await fixture(),
      p = await invite(f);
    now = new Date('2027-01-01T21:59:59.999Z');
    await Promise.all([
      expiry().processTarget(target(f, p.proposalId!)),
      execute(f, 'applicant', {
        action: 'accept',
        proposalId: p.proposalId!,
        body: await body(f),
      }),
    ]);
    now = new Date('2027-01-01T22:00:00Z');
    expect(await expiry().processTarget(target(f, p.proposalId!))).toBe(false);
    expect(await history(f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(0);
  });

  it.each(['accept', 'reject'] as const)(
    'alternative expiry races provider %s and preserves the confirmed commitment',
    async (action) => {
      const f = await fixture(),
        p = await invite(f);
      const confirmed = await execute(f, 'applicant', {
        action: 'accept',
        proposalId: p.proposalId!,
        body: await body(f),
      });
      const alt = await execute(f, 'applicant', {
        action: 'alternative-appointment',
        appointmentId: confirmed.appointmentId!,
        body: {
          ...(await body(f)),
          startsAt: '2027-01-04T10:00:00Z',
          endsAt: '2027-01-04T10:30:00Z',
          timeZone: 'Europe/Berlin',
        },
      });
      now = new Date('2027-01-01T22:00:00Z');
      await Promise.allSettled([
        expiry().processTarget(target(f, alt.proposalId!)),
        execute(f, 'provider', {
          action,
          proposalId: alt.proposalId!,
          body: await body(f),
        }),
      ]);
      const w = await context.prisma.viewingWorkflow.findUniqueOrThrow({
        where: { applicationId: f.app.id },
      });
      expect(w).toMatchObject({
        confirmedAppointmentId: confirmed.appointmentId,
        pendingProposalId: null,
      });
      expect((await app(f)).status).toBe('ACTIVE');
      expect(await history(f, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(1);
    },
  );

  it('48h timeout atomically rejects via SYSTEM, promotes WAITING, retains history and emits both invalidations', async () => {
    const f = await fixture(),
      id = await complete(f);
    for (let i = 0; i < 4; i++) {
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
    const waiter = await person();
    const waiting = await context.prisma.application.create({
      data: {
        listingId: f.listing.id,
        applicantId: waiter.userId,
        status: 'WAITING',
        queueOrder: 1,
      },
    });
    const deadline = await interestDeadline(id);
    now = new Date(deadline.getTime() - 1);
    expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(false);
    now = deadline;
    const projection = await commands().snapshot(
      f.app.id,
      f.applicant.userId,
      'applicant',
    );
    expect(projection.applicantInterest?.state).toBe('EXPIRED');
    expect(projection.obligations).toEqual([]);
    const provider = context.client(f.provider.cookie),
      applicant = context.client(f.applicant.cookie);
    await Promise.all([connected(provider), connected(applicant)]);
    const providerEvents: unknown[] = [],
      applicantEvents: unknown[] = [];
    provider.on('domain-event', (e) => providerEvents.push(e));
    applicant.on('domain-event', (e) => applicantEvents.push(e));
    const old = await context.prisma.outboxEvent.findMany({
      where: { applicationId: f.app.id },
      select: { id: true },
    });
    expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(true);
    expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(false);
    expect(await app(f)).toMatchObject({
      status: 'REJECTED',
      publicReason: 'POST_VIEWING_RESPONSE_EXPIRED',
      withdrawnAt: null,
    });
    expect(
      (
        await context.prisma.application.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toMatchObject([
      { actorType: 'SYSTEM', actorUserId: null },
    ]);
    expect(
      await context.prisma.applicationViewingOutcome.count({
        where: { viewingId: id },
      }),
    ).toBe(1);
    const events = await context.prisma.outboxEvent.findMany({
      where: { applicationId: f.app.id, id: { notIn: old.map((e) => e.id) } },
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      'application.lifecycle.changed',
      'application.viewing.changed',
    ]);
    for (const event of events)
      await context.app.get(RealtimeOutboxPublisher).publish({
        eventId: event.id,
        type: event.type,
        schemaVersion: event.schemaVersion,
        applicationId: event.applicationId,
        conversationId: event.conversationId,
        occurredAt: event.occurredAt,
        payload: event.payload,
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(providerEvents).toHaveLength(2);
    expect(applicantEvents).toHaveLength(2);
    expect(JSON.stringify(providerEvents)).not.toMatch(
      /POST_VIEWING_RESPONSE_EXPIRED|status|interestState|message/,
    );
  });

  it.each([-1, 0])(
    '48h interest submission vs timeout at deadline offset %s has exactly one effective result',
    async (offset) => {
      const f = await fixture(),
        id = await complete(f);
      now = new Date((await interestDeadline(id)).getTime() + offset);
      const input: ViewingWorkflowCommand = {
        action: 'interest',
        appointmentId: id,
        body: { ...(await body(f)), interest: 'STILL_INTERESTED' },
      };
      await Promise.allSettled([
        expiry().processTarget(target(f, id, 'interest')),
        execute(f, 'applicant', input),
      ]);
      expect((await app(f)).status).toBe(offset < 0 ? 'ACTIVE' : 'REJECTED');
      expect(
        await context.prisma.applicationViewingInterest.count({
          where: { viewingId: id },
        }),
      ).toBe(offset < 0 ? 1 : 0);
      expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toHaveLength(
        offset < 0 ? 0 : 1,
      );
    },
  );

  it('a late interest command alone persists lifecycle expiry and its receipt replay is quiet', async () => {
    const f = await fixture(),
      id = await complete(f);
    now = await interestDeadline(id);
    const input: ViewingWorkflowCommand = {
      action: 'interest',
      appointmentId: id,
      body: { ...(await body(f)), interest: 'STILL_INTERESTED' },
    };
    await expect(execute(f, 'applicant', input)).rejects.toMatchObject({
      response: {
        code: 'VIEWING_STATE_CHANGED',
        reason: 'INTEREST_RESPONSE_EXPIRED',
      },
    });
    expect((await app(f)).publicReason).toBe('POST_VIEWING_RESPONSE_EXPIRED');
    const count = await context.prisma.outboxEvent.count({
      where: { applicationId: f.app.id },
    });
    await expect(execute(f, 'applicant', input)).rejects.toMatchObject({
      response: { reason: 'INTEREST_RESPONSE_EXPIRED' },
    });
    expect(
      await context.prisma.outboxEvent.count({
        where: { applicationId: f.app.id },
      }),
    ).toBe(count);
    expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toHaveLength(1);
  });

  it.each(['reject', 'withdraw', 'rent'] as const)(
    'timeout racing lifecycle %s preserves one terminal outcome',
    async (action) => {
      const f = await fixture(),
        id = await complete(f);
      now = await interestDeadline(id);
      const transition =
        action === 'reject'
          ? curation().reject(f.app.id, f.provider.userId)
          : action === 'withdraw'
            ? lifecycle().withdraw(f.app.id, f.applicant.userId)
            : context.app
                .get(ListingsService)
                .rentListing(f.listing.id, f.provider.userId, {
                  selectedApplicationId: f.app.id,
                });
      await Promise.allSettled([
        expiry().processTarget(target(f, id, 'interest')),
        transition,
      ]);
      expect(['REJECTED', 'WITHDRAWN', 'ACCEPTED']).toContain(
        (await app(f)).status,
      );
      expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(
        false,
      );
      const terminal = await context.prisma.applicationActivity.count({
        where: {
          applicationId: f.app.id,
          type: {
            in: [
              'APPLICATION_REJECTED',
              'APPLICATION_WITHDRAWN',
              'APPLICATION_ACCEPTED',
            ],
          },
        },
      });
      expect(terminal).toBe(1);
    },
  );

  it.each(['proposal', 'interest'] as const)(
    'failed %s outbox write rolls back expiry and retries safely',
    async (kind) => {
      const f = await fixture();
      const id =
        kind === 'proposal' ? (await invite(f)).proposalId! : await complete(f);
      now =
        kind === 'proposal'
          ? new Date('2027-01-01T22:00:00Z')
          : await interestDeadline(id);
      const before = await context.prisma.outboxEvent.count({
        where: { applicationId: f.app.id },
      });
      const writer = context.app.get(OutboxWriter),
        real = writer.append.bind(writer);
      jest.spyOn(writer, 'append').mockImplementation(async (tx, event) => {
        await real(tx, event);
        throw new Error('forced expiry rollback');
      });
      await expect(expiry().processTarget(target(f, id, kind))).rejects.toThrow(
        'forced expiry rollback',
      );
      expect((await app(f)).status).toBe('ACTIVE');
      expect(
        await history(
          f,
          kind === 'proposal'
            ? 'VIEWING_PROPOSAL_EXPIRED'
            : 'VIEWING_INTEREST_EXPIRED',
        ),
      ).toHaveLength(0);
      expect(
        await context.prisma.outboxEvent.count({
          where: { applicationId: f.app.id },
        }),
      ).toBe(before);
      jest.restoreAllMocks();
      const result = await Promise.all([
        expiry().processTarget(target(f, id, kind)),
        expiry().processTarget(target(f, id, kind)),
      ]);
      expect(result.sort()).toEqual([false, true]);
    },
  );

  it('lifecycle closure wins before expiry and cannot produce later timeout history', async () => {
    const f = await fixture(),
      id = await complete(f);
    await lifecycle().withdraw(f.app.id, f.applicant.userId);
    now = await interestDeadline(id);
    expect(await expiry().processTarget(target(f, id, 'interest'))).toBe(false);
    expect(await history(f, 'VIEWING_INTEREST_EXPIRED')).toHaveLength(0);
    expect((await app(f)).status).toBe('WITHDRAWN');
    const g = await fixture();
    now = new Date('2027-01-01T10:00:00Z');
    const p = await invite(g);
    await lifecycle().withdraw(g.app.id, g.applicant.userId);
    now = new Date('2027-01-01T22:00:00Z');
    expect(await expiry().processTarget(target(g, p.proposalId!))).toBe(false);
    expect(await history(g, 'VIEWING_PROPOSAL_EXPIRED')).toHaveLength(0);
  });

  it.each([-1, 0])(
    'enforces the derived correction cutoff at offset %s without a worker event',
    async (offset) => {
      const f = await fixture(),
        id = await complete(f);
      now = new Date(now.getTime() + 24 * 3600000 + offset);
      const snapshot = await commands().snapshot(
        f.app.id,
        f.provider.userId,
        'provider',
      );
      expect(
        snapshot.capabilities.find((c) => c.action === 'CORRECT_OUTCOME')
          ?.allowed,
      ).toBe(offset < 0);
      const command = execute(f, 'provider', {
        action: 'outcome',
        appointmentId: id,
        body: {
          ...(await body(f)),
          outcome: 'NO_SHOW',
          absenceSide: 'PROVIDER',
          correctionReason: 'Recorded incorrectly',
        },
      });
      if (offset < 0) await command;
      else
        await expect(command).rejects.toMatchObject({
          response: { code: 'VIEWING_STATE_CHANGED' },
        });
      expect((await app(f)).status).toBe('ACTIVE');
    },
  );
});
