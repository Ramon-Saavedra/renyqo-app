import { ApplicationLifecycleService } from '../src/applications/application-lifecycle.service';
import { ProviderApplicationCurationService } from '../src/applications/provider-application-curation.service';
import { ApplicationTransactionService } from '../src/applications/application-transaction.service';

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:https';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { jest } from '@jest/globals';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { AppModule } from '../src/app.module';
import { ApplicationActivityService } from '../src/applications/application-activity.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationStatus,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;
type Store = InstanceType<ReturnType<typeof connectPgSimple>>;

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (!isRecord(value)) {
    throw new Error('Expected an object response');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Expected string ${key}`);
  return value;
}

describe('ACTIVE consideration priority E2E', () => {
  let now = new Date('2027-01-01T10:00:00Z');
  let app: INestApplication;
  let prisma: PrismaService;
  let store: Store;
  let server: RequestTarget;
  let certificate: Buffer;
  let tlsDirectory: string | undefined;
  let provider: { agent: Agent; id: string };
  let applicant: { agent: Agent; id: string };
  let applicationId: string;
  let listingId: string;

  async function register(role: 'applicant' | 'provider') {
    const agent = request.agent(server).ca(certificate);
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: `Conversation ${role}`,
        email: `${randomUUID()}@e2e.renyqo.test`,
        password: 'StrongPass123',
        role,
        acceptedTerms: true,
        acceptedPrivacy: true,
        ...(role === 'provider' ? { providerType: 'private' } : {}),
      })
      .expect(201);
    const cookies: unknown = response.headers['set-cookie'];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/; Secure(?:;|$)/),
        expect.stringMatching(/; HttpOnly(?:;|$)/),
        expect.stringMatching(/; SameSite=Lax(?:;|$)/),
      ]),
    );
    return { agent, id: getString(body(response), 'id') };
  }

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
      throw new Error('Dedicated E2E database and reset marker required');
    }
    assertSafeE2EDatabaseUrl(url);
    process.env['DATABASE_URL'] = url;
    process.env['NODE_ENV'] = 'test';
    process.env['SESSION_SECRET'] =
      'e2e-session-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ViewingClock)
      .useValue({ now: () => now })
      .compile();
    tlsDirectory = mkdtempSync(join(tmpdir(), 'renyqo-conversation-tls-'));
    const keyPath = join(tlsDirectory, 'key.pem');
    const certPath = join(tlsDirectory, 'cert.pem');
    const openssl =
      process.platform === 'win32'
        ? join(
            process.env['ProgramFiles'] ?? 'C:\\Program Files',
            'Git',
            'usr',
            'bin',
            'openssl.exe',
          )
        : 'openssl';
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-noenc',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore', timeout: 10000 },
    );
    certificate = readFileSync(certPath);
    app = module.createNestApplication({
      httpsOptions: { key: readFileSync(keyPath), cert: certificate },
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    const PgStore = connectPgSimple(session);
    store = new PgStore({
      conString: url,
      tableName: 'user_sessions',
      createTableIfMissing: false,
    });
    app.use(
      session({
        store,
        secret: process.env['SESSION_SECRET'],
        resave: false,
        saveUninitialized: false,
        name: 'sid',
        cookie: { secure: true, httpOnly: true, sameSite: 'lax' },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());
    prisma = app.get(PrismaService);
    await app.init();
    const target: unknown = app.getHttpServer();
    if (!(target instanceof Server)) throw new Error('Missing HTTP server');
    server = target;
  });

  beforeEach(async () => {
    now = new Date('2027-01-01T10:00:00Z');
    provider = await register('provider');
    applicant = await register('applicant');
    const listing = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 1,
        status: ListingStatus.PUBLISHED,
        title: 'Conversation listing',
        publishedAt: new Date(),
      },
    });
    listingId = listing.id;
    const application = await prisma.application.create({
      data: {
        listingId,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    applicationId = application.id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const url = process.env['E2E_DATABASE_URL'];
    if (
      !url ||
      process.env['DATABASE_URL'] !== url ||
      process.env['NODE_ENV'] !== 'test' ||
      process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
    ) {
      throw new Error('Unsafe E2E cleanup configuration');
    }
    assertSafeE2EDatabaseUrl(url);
    if (!prisma) return;
    await prisma.$executeRaw`TRUNCATE TABLE application_no_show_consequences, viewing_command_receipts, viewing_workflows, viewing_proposals, viewing_appointments, application_consideration_positions, application_viewing_interests, application_viewing_outcomes, application_viewings`;
    await prisma.application.deleteMany();
    await prisma.listingReport.deleteMany();
    await prisma.savedListing.deleteMany();
    await prisma.listingImage.deleteMany();
    await prisma.listingEvent.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.applicantProfile.deleteMany();
    await prisma.passwordResetToken.deleteMany();
    await prisma.userSession.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        if (store) await Promise.resolve(store.close());
      } finally {
        if (tlsDirectory)
          rmSync(tlsDirectory, { recursive: true, force: true });
      }
    }
  });

  function endpoint(side: 'provider' | 'applicant', suffix = '') {
    return `/api/v1/${side}/applications/${applicationId}/viewing-workflow${suffix}`;
  }
  function nested(row: Record<string, unknown>, key: string) {
    const value = row[key];
    if (!isRecord(value)) throw new Error(`Expected object ${key}`);
    return value;
  }
  function schedule(startsAt = '2027-01-03T10:00:00.000Z') {
    return {
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
      timeZone: 'Europe/Berlin',
      message: 'Meet at the entrance',
    };
  }
  function command(
    expectedWorkflowRevision: number,
    fields: Record<string, unknown> = {},
    requestKey = randomUUID(),
  ) {
    return { requestKey, expectedWorkflowRevision, ...fields };
  }
  async function snapshot(side: 'provider' | 'applicant' = 'provider') {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .get(endpoint(side))
        .expect(200),
    );
  }
  async function post(
    side: 'provider' | 'applicant',
    suffix: string,
    input: Record<string, unknown>,
    status = 200,
  ) {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .post(endpoint(side, suffix))
        .send(input)
        .expect(status),
    );
  }
  async function invite() {
    return post('provider', '/invitations', command(0, schedule()));
  }
  async function confirmed() {
    const id = getString(await invite(), 'proposalId');
    return getString(
      await post('applicant', `/proposals/${id}/accept`, command(1)),
      'appointmentId',
    );
  }

  async function add(status: 'ACTIVE' | 'WAITING' = 'ACTIVE') {
    const user = await register('applicant');
    const application = await prisma.application.create({
      data: {
        listingId,
        applicantId: user.id,
        status,
        activeAt: status === 'ACTIVE' ? now : null,
      },
    });
    return { user, application };
  }
  async function position(id = applicationId) {
    return prisma.applicationConsiderationPosition.findUniqueOrThrow({
      where: { applicationId: id },
    });
  }
  async function cards() {
    const response = await provider.agent
      .get(`/api/v1/provider/listings/${listingId}/active-applications`)
      .expect(200);
    const value: unknown = response.body;
    if (!Array.isArray(value) || !value.every(isRecord))
      throw new Error('Expected active cards');
    return value;
  }
  async function order() {
    return (await cards()).map((row) => getString(row, 'id'));
  }
  function done() {
    now = new Date('2027-01-03T10:30:00Z');
  }
  async function absence(
    id: string,
    fields: Record<string, unknown> = {
      outcome: 'NO_SHOW',
      absenceSide: 'APPLICANT',
    },
    revision = 2,
    key = randomUUID(),
  ) {
    return post(
      'provider',
      `/appointments/${id}/outcome`,
      command(revision, fields, key),
    );
  }
  async function confirmedFor(id: string, user: { agent: Agent }) {
    const base = `/api/v1/provider/applications/${id}/viewing-workflow`;
    const p = getString(
      body(
        await provider.agent
          .post(`${base}/invitations`)
          .send(command(0, schedule()))
          .expect(200),
      ),
      'proposalId',
    );
    await user.agent
      .post(
        `/api/v1/applicant/applications/${id}/viewing-workflow/proposals/${p}/accept`,
      )
      .send(command(1))
      .expect(200);
    return p;
  }
  async function releaseCooldown() {
    await prisma.listingEvent.updateMany({
      where: { applicationId },
      data: { occurredAt: new Date(Date.now() - 60 * 60_000) },
    });
  }

  async function viewingAttention(side: 'provider' | 'applicant') {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .get(`/api/v1/${side}/applications/${applicationId}/attention`)
        .expect(200),
    );
  }
  async function workspaceViewing(side: 'provider' | 'applicant') {
    return nested(
      body(
        await (side === 'provider' ? provider : applicant).agent
          .get(`/api/v1/${side}/applications/${applicationId}/workspace`)
          .expect(200),
      ),
      'viewingSummary',
    );
  }
  it('projects binding appointment and pending alternative identically in workflow, attention, cards and workspaces', async () => {
    const id = await confirmed();
    const proposalId = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(2, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    for (const side of ['provider', 'applicant'] as const) {
      const w = await snapshot(side);
      const view = await workspaceViewing(side);
      for (const projection of [
        w,
        view,
        nested(await viewingAttention(side), 'viewing'),
      ]) {
        expect(projection).toMatchObject({
          workflowRevision: 3,
          confirmedAppointment: {
            appointmentId: id,
            timing: 'NORMAL',
            shortNotice: false,
          },
          pendingProposal: { proposalId, baseAppointmentId: id },
          obligations: [
            {
              responsibleSide: 'PROVIDER',
              target: { applicationId, proposalId, appointmentId: id },
            },
          ],
        });
      }
    }
    const attention = await viewingAttention('provider');
    expect(attention.pendingActionCount).toBe(1);
    expect(attention.targets).toMatchObject([
      {
        workflowTarget: {
          proposalId,
          appointmentId: id,
          action: 'RESPOND_TO_PROPOSAL',
        },
      },
    ]);
    expect((await cards())[0]).toMatchObject({
      viewing: {
        confirmedAppointment: { appointmentId: id },
        pendingProposal: { proposalId },
      },
    });
    const overview = body(
      await provider.agent
        .get(`/api/v1/provider/listings/${listingId}/application-overview`)
        .expect(200),
    );
    expect(overview.activeApplications).toMatchObject([
      { viewing: { pendingProposal: { proposalId } } },
    ]);
  });
  it('recomputes expired invitation attention on HTTP reads without resolving or mutating history', async () => {
    const id = getString(await invite(), 'proposalId');
    expect(await viewingAttention('applicant')).toMatchObject({
      pendingActionCount: 1,
      nextRevalidateAt: '2027-01-01T22:00:00.000Z',
    });
    now = new Date('2027-01-01T22:00:00Z');
    expect(await viewingAttention('applicant')).toMatchObject({
      pendingActionCount: 0,
      viewing: {
        pendingProposal: {
          effectiveResolution: 'EXPIRED',
          resolution: 'PENDING',
        },
      },
    });
    expect(
      await prisma.viewingProposal.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ resolution: 'PENDING' });
  });
  it('keeps confirmed appointment in applicant overview after attention clears', async () => {
    const id = await confirmed();
    const overview = body(
      await applicant.agent
        .get('/api/v1/applicant/applications/overview')
        .expect(200),
    );
    expect(overview.items).toMatchObject([
      {
        viewing: { confirmedAppointment: { appointmentId: id } },
        attention: { pendingActionCount: 0 },
      },
    ]);
  });
  it('enforces time boundaries in capabilities and schedules the next HTTP revalidation', async () => {
    await confirmed();
    now = new Date('2027-01-03T04:00:00Z');
    expect((await snapshot('applicant')).capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'PROPOSE_REPLACEMENT',
          allowed: false,
          blockedReason: 'APPLICANT_CHANGE_CUTOFF_PASSED',
        }),
        expect.objectContaining({
          action: 'CANCEL_APPOINTMENT',
          allowed: true,
        }),
      ]),
    );
    expect((await snapshot('applicant')).nextRevalidateAt).toBe(
      '2027-01-03T10:00:00.000Z',
    );
    now = new Date('2027-01-03T10:00:00Z');
    expect((await snapshot('applicant')).capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'CANCEL_APPOINTMENT',
          allowed: false,
          blockedReason: 'APPOINTMENT_ALREADY_STARTED',
        }),
      ]),
    );
    expect((await snapshot()).nextRevalidateAt).toBe(
      '2027-01-03T10:30:00.000Z',
    );
    done();
    expect(await viewingAttention('provider')).toMatchObject({
      pendingActionCount: 1,
      viewing: {
        nextObligation: { action: 'PROVIDER_RECORD_VIEWING_OUTCOME' },
      },
    });
  });
  it('exposes interest and provider decisions without duplicate actions and expires interest on read', async () => {
    const id = await confirmed();
    done();
    await absence(id, { outcome: 'COMPLETED' });
    expect(await viewingAttention('applicant')).toMatchObject({
      pendingActionCount: 1,
      viewing: {
        applicantInterest: {
          state: 'PENDING',
          deadlineAt: '2027-01-05T10:30:00.000Z',
        },
      },
    });
    expect(await viewingAttention('provider')).toMatchObject({
      pendingActionCount: 1,
      pendingActions: [{ type: 'DECIDE_VIEWING_CONSIDERATION' }],
    });
    await post(
      'provider',
      `/appointments/${id}/consideration`,
      command(3, { consideration: 'UNDECIDED' }),
    );
    expect(await viewingAttention('provider')).toMatchObject({
      pendingActionCount: 0,
      viewing: {
        providerConsideration: { state: 'UNDECIDED', decisionRequired: false },
      },
    });
    now = new Date('2027-01-05T10:30:00Z');
    expect(await viewingAttention('applicant')).toMatchObject({
      pendingActionCount: 0,
      viewing: {
        applicantInterest: { state: 'EXPIRED', lifecycleExpiryPending: true },
      },
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('ACTIVE');
  });
  it('exposes provider absence without applicant marker or priority change', async () => {
    const original = await position();
    const id = await confirmed();
    done();
    await absence(id, { outcome: 'NO_SHOW', absenceSide: 'PROVIDER' });
    expect(await workspaceViewing('provider')).toMatchObject({
      outcome: {
        outcome: 'NO_SHOW',
        absenceSide: 'PROVIDER',
        appointmentId: id,
        startsAt: '2027-01-03T10:00:00.000Z',
      },
    });
    expect((await cards())[0]).toMatchObject({
      consideration: { applicantNoShow: null },
    });
    expect(await position()).toEqual(original);
  });

  it('does not revive completed interest or provider consideration on restore or new invitation', async () => {
    const id = await confirmed();
    done();
    await absence(id, { outcome: 'COMPLETED' });
    const curation = app.get(ProviderApplicationCurationService);
    await curation.reject(applicationId, provider.id);
    await releaseCooldown();
    await curation.restore(applicationId, provider.id);
    for (let round = 0; round < 2; round++) {
      const w = await snapshot();
      expect(w.confirmedAppointment).toBeNull();
      expect(w.obligations).toEqual(
        round === 0
          ? []
          : [
              expect.objectContaining({
                action: 'APPLICANT_RESPOND_TO_VIEWING',
              }),
            ],
      );
      expect(w.providerConsideration).toMatchObject({
        decisionRequired: false,
      });
      const revision = w.workflowRevision;
      if (typeof revision !== 'number') throw new Error('Missing revision');
      const conflict = await post(
        'provider',
        `/appointments/${id}/consideration`,
        command(revision, { consideration: 'CONTINUE_CONSIDERING' }),
        409,
      );
      expect(conflict).toMatchObject({
        code: 'VIEWING_STATE_CHANGED',
        reason: 'POST_VIEWING_DECISION_CLOSED',
      });
      if (round === 0)
        await post(
          'provider',
          '/invitations',
          command(revision, schedule('2027-01-05T10:00:00.000Z')),
        );
    }
  });

  it('keeps declined and accepted proposal dates/messages readable with exact targets and stable round pagination', async () => {
    const id = await confirmed();
    const alternative = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(2, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('provider', `/proposals/${alternative}/reject`, command(3));
    for (const side of ['provider', 'applicant'] as const) {
      const actor = side === 'provider' ? provider : applicant;
      const first = body(
        await actor.agent.get(endpoint(side, '/proposals?limit=1')).expect(200),
      );
      expect(first).toMatchObject({
        items: [
          {
            proposalId: alternative,
            resolution: 'DECLINED',
            message: 'Meet at the entrance',
            startsAt: '2027-01-04T10:00:00.000Z',
            target: {
              applicationId,
              proposalId: alternative,
              action: 'VIEW_PROPOSAL',
            },
          },
        ],
        pagination: { hasMore: true, nextBeforeRound: 2 },
      });
      const second = body(
        await actor.agent
          .get(endpoint(side, '/proposals?limit=1&beforeRound=2'))
          .expect(200),
      );
      expect(second).toMatchObject({
        items: [
          {
            proposalId: id,
            resolution: 'ACCEPTED',
            appointment: { status: 'ACCEPTED', appointmentId: id },
          },
        ],
        pagination: { hasMore: false, nextBeforeRound: null },
      });
      expect(
        body(
          await actor.agent
            .get(endpoint(side, `/proposals/${alternative}`))
            .expect(200),
        ),
      ).toMatchObject({ proposalId: alternative, resolution: 'DECLINED' });
      await actor.agent
        .get(endpoint(side, `/proposals/${randomUUID()}`))
        .expect(404);
    }
    const outsider = await register('applicant');
    await outsider.agent
      .get(endpoint('applicant', `/proposals/${alternative}`))
      .expect(404);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: 'WAITING' },
    });
    await provider.agent.get(endpoint('provider', '/proposals')).expect(404);
    await provider.agent
      .get(endpoint('provider', `/proposals/${alternative}`))
      .expect(404);
  });

  it('keeps attributed attendance corrections and interest deadlines in proposal history', async () => {
    const id = await confirmed();
    done();
    await absence(id);
    await absence(
      id,
      {
        outcome: 'COMPLETED',
        correctionReason: 'Applicant attended after all',
      },
      3,
    );
    const history = body(
      await provider.agent
        .get(endpoint('provider', `/proposals/${id}`))
        .expect(200),
    );
    expect(history).toMatchObject({
      appointment: {
        status: 'COMPLETED',
        outcomes: [
          { revision: 1, outcome: 'NO_SHOW', absenceSide: 'APPLICANT' },
          { revision: 2, outcome: 'COMPLETED', absenceSide: null },
        ],
        applicantInterest: {
          state: 'PENDING',
          deadlineAt: '2027-01-05T10:30:00.000Z',
        },
      },
    });
  });
  it.each(['provider', 'applicant'] as const)(
    'keeps structured %s cancellation in history',
    async (side) => {
      const id = await confirmed();
      if (side === 'applicant')
        await post(
          'applicant',
          `/appointments/${id}/cancel`,
          command(2, { message: 'Cannot attend' }),
        );
      else {
        const w = await snapshot();
        await post(
          'provider',
          `/${getString(w, 'workflowId')}/close`,
          command(2, {
            proposalId: null,
            appointmentId: id,
            reason: 'PROVIDER_ILLNESS',
            message: 'Cannot attend',
          }),
        );
      }
      const history = body(
        await applicant.agent
          .get(endpoint('applicant', `/proposals/${id}`))
          .expect(200),
      );
      expect(history).toMatchObject({
        appointment: {
          status: 'CANCELLED',
          cancellation: {
            by: side === 'applicant' ? 'APPLICANT' : 'PROVIDER',
            reason:
              side === 'applicant' ? 'APPLICANT_CANCELLED' : 'PROVIDER_ILLNESS',
            message: 'Cannot attend',
          },
        },
      });
    },
  );

  it('assigns deterministic ACTIVE entry order independently of activeAt ties and WAITING queue', async () => {
    const b = await add();
    const c = await add();
    const d = await add();
    const waiting = await add('WAITING');
    expect(await order()).toEqual([
      applicationId,
      b.application.id,
      c.application.id,
      d.application.id,
    ]);
    expect(
      await prisma.applicationConsiderationPosition.findUnique({
        where: { applicationId: waiting.application.id },
      }),
    ).toBeNull();
    const before = await position(b.application.id);
    await prisma.application.update({
      where: { id: b.application.id },
      data: { status: 'ACTIVE', activeAt: new Date('2020-01-01T00:00:00Z') },
    });
    expect(await position(b.application.id)).toEqual(before);
    expect(
      await app
        .get(ApplicationLifecycleService)
        .promoteWaitingApplications(listingId),
    ).toBe(1);
    expect(await order()).toEqual([
      applicationId,
      b.application.id,
      c.application.id,
      d.application.id,
      waiting.application.id,
    ]);
  });

  it('moves only applicant absence to the tail and exposes authoritative marker on both active reads and workspace', async () => {
    const others = [];
    for (let index = 0; index < 4; index++) others.push(await add());
    const waiting = await add('WAITING');
    const initial = await order();
    const before = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
    });
    const id = await confirmed();
    done();
    await absence(id);
    const result = await order();
    expect(result).toEqual([
      ...initial.filter((id) => id !== applicationId),
      applicationId,
    ]);
    expect(
      await prisma.application.findUniqueOrThrow({
        where: { id: applicationId },
      }),
    ).toMatchObject({
      status: 'ACTIVE',
      activeAt: before.activeAt,
      queueOrder: before.queueOrder,
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: waiting.application.id },
        })
      ).status,
    ).toBe('WAITING');
    expect(
      await prisma.application.count({
        where: { listingId, status: 'ACTIVE' },
      }),
    ).toBe(5);
    expect(others).toHaveLength(4);
    const consideration = nested((await cards()).at(-1)!, 'consideration');
    expect(nested(consideration, 'applicantNoShow')).toMatchObject({
      code: 'APPLICANT_NO_SHOW',
      appointmentId: id,
    });
    expect(typeof consideration.position).toBe('string');
    const overview = body(
      await provider.agent
        .get(`/api/v1/provider/listings/${listingId}/application-overview`)
        .expect(200),
    );
    const overviewCards: unknown = overview.activeApplications;
    if (!Array.isArray(overviewCards) || !overviewCards.every(isRecord))
      throw new Error('Missing overview cards');
    expect(overviewCards.map((row) => getString(row, 'applicationId'))).toEqual(
      result,
    );
    expect(nested(overviewCards.at(-1)!, 'consideration')).toEqual(
      consideration,
    );
    const workspace = body(
      await provider.agent
        .get(`/api/v1/provider/applications/${applicationId}/workspace`)
        .expect(200),
    );
    expect(workspace.consideration).toEqual(consideration);
    expect(await prisma.applicationNoShowConsequence.count()).toBe(1);
  });

  it.each(['PROVIDER', 'BOTH', 'COMPLETED'] as const)(
    'does not reorder or penalize %s',
    async (kind) => {
      await add();
      const before = await position();
      const id = await confirmed();
      done();
      await absence(
        id,
        kind === 'COMPLETED'
          ? { outcome: 'COMPLETED' }
          : { outcome: 'NO_SHOW', absenceSide: kind },
      );
      expect(await position()).toEqual(before);
      expect(await prisma.applicationNoShowConsequence.count()).toBe(0);
      expect(
        nested((await cards())[0], 'consideration').applicantNoShow,
      ).toBeNull();
    },
  );

  it.each(['COMPLETED', 'PROVIDER'] as const)(
    'reconciles an incorrect applicant no-show to %s without moving other applicants',
    async (outcome) => {
      await add();
      await add();
      const initialOrder = await order();
      const before = await position();
      const id = await confirmed();
      done();
      await absence(id);
      const effect =
        await prisma.applicationNoShowConsequence.findFirstOrThrow();
      await absence(
        id,
        outcome === 'COMPLETED'
          ? { outcome: 'COMPLETED', correctionReason: 'Attendance confirmed' }
          : {
              outcome: 'NO_SHOW',
              absenceSide: 'PROVIDER',
              correctionReason: 'Provider was absent',
            },
        3,
      );
      expect(await order()).toEqual(initialOrder);
      expect((await position()).position).toBe(before.position);
      expect((await position()).revision).toBe(effect.appliedRevision + 1);
      expect(
        await prisma.applicationNoShowConsequence.findFirstOrThrow(),
      ).toMatchObject({
        positionRestored: true,
      });
      expect(
        typeof (await prisma.applicationNoShowConsequence.findFirstOrThrow())
          .correctedByOutcomeId,
      ).toBe('string');
      expect(
        await prisma.applicationViewingOutcome.count({
          where: { viewingId: id },
        }),
      ).toBe(2);
      expect(
        nested((await cards())[0], 'consideration').applicantNoShow,
      ).toBeNull();
    },
  );

  it('does not undo later activation order when correcting an old no-show', async () => {
    await add();
    const id = await confirmed();
    done();
    await absence(id);
    const curation = app.get(ProviderApplicationCurationService);
    await curation.reject(applicationId, provider.id);
    await releaseCooldown();
    await curation.restore(applicationId, provider.id);
    const restored = await position();
    await absence(
      id,
      { outcome: 'COMPLETED', correctionReason: 'Attendance confirmed' },
      5,
    );
    expect(await position()).toEqual(restored);
    expect(
      await prisma.applicationNoShowConsequence.findFirstOrThrow(),
    ).toMatchObject({ positionRestored: false });
    expect(
      nested((await cards()).at(-1)!, 'consideration').applicantNoShow,
    ).toBeNull();
  });

  it('serializes concurrent no-shows for different applicants with unique tail allocations', async () => {
    const b = await add();
    const c = await add();
    const one = await confirmed();
    const two = await confirmedFor(b.application.id, b.user);
    done();
    const [first, second] = await Promise.all([
      provider.agent
        .post(endpoint('provider', `/appointments/${one}/outcome`))
        .send(command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' })),
      provider.agent
        .post(
          `/api/v1/provider/applications/${b.application.id}/viewing-workflow/appointments/${two}/outcome`,
        )
        .send(command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' })),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const result = await order();
    expect(result[0]).toBe(c.application.id);
    expect(new Set(result.slice(1))).toEqual(
      new Set([applicationId, b.application.id]),
    );
    expect((await position()).position).not.toBe(
      (await position(b.application.id)).position,
    );
    expect(await prisma.applicationNoShowConsequence.count()).toBe(2);
  });

  it('serializes no-show with a new ACTIVE admission without slot or position loss', async () => {
    const b = await add();
    const id = await confirmed();
    const entrant = await register('applicant');
    done();
    const [result, admitted] = await Promise.all([
      absence(id),
      app.get(ApplicationLifecycleService).apply(listingId, entrant.id),
    ]);
    expect(result.workflowRevision).toBe(3);
    expect(admitted.status).toBe('ACTIVE');
    expect((await order())[0]).toBe(b.application.id);
    expect(new Set(await order())).toEqual(
      new Set([applicationId, b.application.id, admitted.id]),
    );
  });

  it('correction racing with another applicant no-show preserves both independent decisions', async () => {
    const b = await add();
    const c = await add();
    const one = await confirmed();
    const two = await confirmedFor(b.application.id, b.user);
    done();
    await absence(one);
    const results = await Promise.all([
      provider.agent
        .post(endpoint('provider', `/appointments/${one}/outcome`))
        .send(
          command(3, {
            outcome: 'COMPLETED',
            correctionReason: 'Attendance confirmed',
          }),
        ),
      provider.agent
        .post(
          `/api/v1/provider/applications/${b.application.id}/viewing-workflow/appointments/${two}/outcome`,
        )
        .send(command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' })),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await order()).toEqual([
      applicationId,
      c.application.id,
      b.application.id,
    ]);
  });

  it.each(['promotion', 'restore'] as const)(
    'serializes promotion vs restore for the final ACTIVE slot with %s acquiring the lock first',
    async (first) => {
      const active = [];
      for (let i = 0; i < 4; i++) active.push(await add());
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          status: 'REJECTED',
          publicReason: 'NOT_SELECTED',
          rejectedAt: now,
        },
      });
      const oldest = await add('WAITING'),
        next = await add('WAITING');
      expect(oldest.application.queueOrder).toBeLessThan(
        next.application.queueOrder,
      );
      const lifecycle = app.get(ApplicationLifecycleService),
        curation = app.get(ProviderApplicationCurationService);
      const locks = app.get(ApplicationTransactionService),
        realLock = locks.lockListing.bind(locks);
      let locked!: () => void, competing!: () => void, release!: () => void;
      const firstLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const secondAttempted = new Promise<void>((resolve) => {
        competing = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      jest.spyOn(locks, 'lockListing').mockImplementation(async (tx, id) => {
        if (id !== listingId) return realLock(tx, id);
        const call = ++calls;
        if (call === 2) competing();
        await realLock(tx, id);
        if (call === 1) {
          locked();
          await proceed;
        }
      });
      const promote = () => lifecycle.promoteWaitingApplications(listingId);
      const restore = () => curation.restore(applicationId, provider.id);
      const winner = first === 'promotion' ? promote() : restore();
      await firstLocked;
      const contender = first === 'promotion' ? restore() : promote();
      try {
        await secondAttempted;
      } finally {
        release();
      }
      await Promise.all([winner, contender]);
      // Existing eligible WAITING wins even when restoration owns the lock first.
      const restored = await prisma.application.findUniqueOrThrow({
        where: { id: applicationId },
      });
      expect(restored.status).toBe('WAITING');
      const oldestAfter = await prisma.application.findUniqueOrThrow({
        where: { id: oldest.application.id },
      });
      expect(oldestAfter.status).toBe('ACTIVE');
      expect(
        await prisma.application.count({
          where: { listingId, status: 'ACTIVE' },
        }),
      ).toBe(5);
      const queue = await prisma.application.findMany({
        where: { listingId, status: 'WAITING' },
        orderBy: [{ queueOrder: 'asc' }, { id: 'asc' }],
      });
      expect(queue.map((row) => row.id)).toEqual([
        next.application.id,
        applicationId,
      ]);
      const ordered = await order();
      const finalId = oldest.application.id;
      expect(ordered).toHaveLength(5);
      expect(ordered.at(-1)).toBe(finalId);
      const positions = await prisma.applicationConsiderationPosition.findMany({
        where: { applicationId: { in: ordered } },
      });
      expect(new Set(positions.map((row) => row.position)).size).toBe(5);
      for (const a of active)
        expect((await position(a.application.id)).position).toBeLessThan(
          (await position(finalId)).position,
        );
      expect(await promote()).toBe(0);
      await expect(restore()).rejects.toMatchObject({ status: 409 });
      expect(
        await prisma.applicationActivity.count({
          where: { applicationId, type: 'APPLICATION_RESTORED' },
        }),
      ).toBe(1);
      expect(
        await prisma.applicationActivity.count({
          where: {
            applicationId: oldest.application.id,
            type: 'APPLICATION_PROMOTED_TO_ACTIVE',
          },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { applicationId, type: 'application.lifecycle.changed' },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: {
            applicationId: oldest.application.id,
            type: 'application.lifecycle.changed',
          },
        }),
      ).toBe(1);
      expect(
        await prisma.listingEvent.count({
          where: { applicationId, type: 'RESTORED_BY_PROVIDER' },
        }),
      ).toBe(1);
    },
  );

  it('restore WAITING does not allocate until promotion and never uses queueOrder as consideration priority', async () => {
    const others = [];
    for (let i = 0; i < 4; i++) others.push(await add());
    const waiting = await add('WAITING');
    const old = await position();
    const curation = app.get(ProviderApplicationCurationService);
    await curation.reject(applicationId, provider.id);
    await releaseCooldown();
    await curation.restore(applicationId, provider.id);
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('WAITING');
    expect(await position()).toEqual(old);
    await app
      .get(ApplicationLifecycleService)
      .withdraw(others[0].application.id, others[0].user.id);
    expect((await order()).at(-1)).toBe(applicationId);
    expect((await position()).position).toBeGreaterThan(old.position);
    expect(await order()).toContain(waiting.application.id);
    expect(
      await prisma.application.count({
        where: { listingId, status: 'ACTIVE' },
      }),
    ).toBe(5);
  });

  it('durably deduplicates outcome commands without allocating or penalizing twice', async () => {
    await add();
    const id = await confirmed();
    done();
    const input = command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' });
    const results = await Promise.all([
      provider.agent
        .post(endpoint('provider', `/appointments/${id}/outcome`))
        .send(input),
      provider.agent
        .post(endpoint('provider', `/appointments/${id}/outcome`))
        .send(input),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(body(results[0])).toEqual(body(results[1]));
    expect(await prisma.applicationNoShowConsequence.count()).toBe(1);
    expect((await position()).revision).toBe(1);
    expect((await snapshot()).workflowRevision).toBe(3);
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      409,
    );
  });

  it('rejects future, invalid, cancelled and expired invitation targets without ordering changes', async () => {
    const id = await confirmed();
    const before = await position();
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      409,
    );
    await post(
      'provider',
      `/appointments/${randomUUID()}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      409,
    );
    await post('applicant', `/appointments/${id}/cancel`, command(2));
    done();
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(3, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      409,
    );
    expect(await position()).toEqual(before);
    expect(await prisma.applicationNoShowConsequence.count()).toBe(0);
  });

  it('expired invitations never become applicant no-shows or change order', async () => {
    const before = await position();
    const id = getString(await invite(), 'proposalId');
    now = new Date('2027-01-01T22:00:00Z');
    await post('applicant', `/proposals/${id}/accept`, command(1), 409);
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      409,
    );
    expect(await position()).toEqual(before);
    expect(await prisma.applicationNoShowConsequence.count()).toBe(0);
  });

  it('correction racing with restore never overwrites the new activation position', async () => {
    await add();
    const id = await confirmed();
    done();
    await absence(id);
    const curation = app.get(ProviderApplicationCurationService);
    await curation.reject(applicationId, provider.id);
    await releaseCooldown();
    const [response] = await Promise.all([
      provider.agent
        .post(endpoint('provider', `/appointments/${id}/outcome`))
        .send(
          command(4, {
            outcome: 'COMPLETED',
            correctionReason: 'Attendance confirmed',
          }),
        ),
      curation.restore(applicationId, provider.id),
    ]);
    expect([200, 409]).toContain(response.status);
    const restored = await position();
    if (response.status === 409) {
      expect(body(response).code).toBe('VIEWING_STATE_CHANGED');
      await absence(
        id,
        { outcome: 'COMPLETED', correctionReason: 'Attendance confirmed' },
        5,
      );
    }
    expect(await position()).toEqual(restored);
    expect(
      (await prisma.applicationNoShowConsequence.findFirstOrThrow())
        .positionRestored,
    ).toBe(false);
    expect(
      nested((await cards()).at(-1)!, 'consideration').applicantNoShow,
    ).toBeNull();
  });

  it('rolls back attendance, consideration movement and its audit when history fails', async () => {
    await add();
    const before = await position();
    const id = await confirmed();
    done();
    jest
      .spyOn(app.get(ApplicationActivityService), 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('no-show history failure'));
    await post(
      'provider',
      `/appointments/${id}/outcome`,
      command(2, { outcome: 'NO_SHOW', absenceSide: 'APPLICANT' }),
      500,
    );
    expect(await position()).toEqual(before);
    expect(await prisma.applicationNoShowConsequence.count()).toBe(0);
    expect(
      await prisma.applicationViewingOutcome.count({
        where: { viewingId: id },
      }),
    ).toBe(0);
  });

  it('enforces ordering revisions and append-only attendance consequence sources in PostgreSQL', async () => {
    const b = await add();
    const current = await position();
    await expect(
      prisma.$executeRaw`UPDATE application_consideration_positions SET position=position+100 WHERE application_id=${applicationId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE application_consideration_positions SET position=${current.position},revision=revision+1 WHERE application_id=${b.application.id}::uuid`,
    ).rejects.toThrow();
    const id = await confirmed();
    done();
    await absence(id);
    await expect(
      prisma.$executeRaw`UPDATE application_no_show_consequences SET previous_position=previous_position+1 WHERE application_id=${applicationId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM application_no_show_consequences WHERE application_id=${applicationId}::uuid`,
    ).rejects.toThrow();
  });
});
