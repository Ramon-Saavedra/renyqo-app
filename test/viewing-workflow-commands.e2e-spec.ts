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
import { runSerializableTransaction } from '../src/prisma/run-serializable-transaction';
import {
  ApplicationStatus,
  ApplicationActivityType,
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

describe('Viewing workflow commands E2E', () => {
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

  function path(side: 'provider' | 'applicant', suffix = ''): string {
    return `/api/v1/${side}/applications/${applicationId}/viewings${suffix}`;
  }

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
  async function legacyProposal() {
    const s = schedule();
    return getString(
      body(
        await provider.agent
          .post(path('provider'))
          .send({
            requestKey: randomUUID(),
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            timeZone: s.timeZone,
            providerNote: 'Legacy note',
          })
          .expect(201),
      ),
      'viewingId',
    );
  }
  async function legacySnapshot(id: string) {
    await runSerializableTransaction(prisma, async (tx) => {
      const row = await tx.applicationViewing.findUniqueOrThrow({
        where: { id },
      });
      await tx.viewingWorkflow.create({
        data: {
          id: applicationId,
          applicationId,
          mode: 'LEGACY',
          pendingProposalId: id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
      await tx.$executeRaw`INSERT INTO viewing_proposals SELECT * FROM legacy_viewing_proposal_rows(${applicationId}::uuid)`;
    });
  }

  it('negotiates a concrete alternative to an invitation and confirms it by provider acceptance', async () => {
    const original = getString(await invite(), 'proposalId');
    expect(
      nested(await snapshot('applicant'), 'pendingProposal'),
    ).toMatchObject({
      responseDeadlineAt: '2027-01-01T22:00:00.000Z',
      proposerSide: 'PROVIDER',
      responderSide: 'APPLICANT',
    });
    const proposed = getString(
      await post(
        'applicant',
        `/proposals/${original}/alternative`,
        command(1, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    expect(nested(await snapshot(), 'pendingProposal')).toMatchObject({
      proposalId: proposed,
      proposerSide: 'APPLICANT',
      message: 'Meet at the entrance',
    });
    expect(
      await post('provider', `/proposals/${proposed}/accept`, command(2)),
    ).toMatchObject({ workflowRevision: 3, appointmentId: proposed });
    expect((await snapshot()).pendingProposal).toBeNull();
  });

  it('keeps the confirmed commitment during negotiation and atomically replaces it on acceptance', async () => {
    const id = await confirmed();
    const next = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(2, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      id,
    );
    await post('provider', `/proposals/${next}/accept`, command(3));
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('SUPERSEDED');
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      next,
    );
    expect(
      await prisma.applicationViewing.count({
        where: { applicationId, status: 'ACCEPTED' },
      }),
    ).toBe(1);
    expect(await prisma.viewingAppointment.count()).toBe(2);
  });

  it('supports rejection, atomic counterproposal, provider replacement and withdrawal without losing confirmation', async () => {
    const id = await confirmed();
    let alt = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(2, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('provider', `/proposals/${alt}/reject`, command(3));
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      id,
    );
    alt = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(4, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    const counter = getString(
      await post(
        'provider',
        `/proposals/${alt}/counterproposal`,
        command(5, schedule('2027-01-05T10:00:00.000Z')),
      ),
      'proposalId',
    );
    expect(
      (await prisma.viewingProposal.findUniqueOrThrow({ where: { id: alt } }))
        .resolution,
    ).toBe('DECLINED');
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      id,
    );
    await post('applicant', `/proposals/${counter}/reject`, command(6));
    alt = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(7, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('applicant', `/proposals/${alt}/withdraw`, command(8));
    const offered = getString(
      await post(
        'provider',
        `/appointments/${id}/replacement`,
        command(9, schedule('2027-01-05T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('applicant', `/proposals/${offered}/accept`, command(10));
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      offered,
    );
  });

  it('records late applicant cancellation without application rejection or automatic rebooking', async () => {
    const id = await confirmed();
    now = new Date('2027-01-03T05:00:00.000Z');
    await post(
      'applicant',
      `/appointments/${id}/cancel`,
      command(2, { message: 'Unable to attend' }),
    );
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({
      cancelledBy: 'APPLICANT',
      cancellationReason: 'APPLICANT_CANCELLED',
      lateCancellation: true,
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(await snapshot()).toMatchObject({
      pendingProposal: null,
      confirmedAppointment: null,
    });
  });

  it('closes the flow with exact targets and attributed provider reason', async () => {
    const id = await confirmed();
    const workflowId = getString(await snapshot(), 'workflowId');
    await post(
      'provider',
      `/${workflowId}/close`,
      command(2, {
        proposalId: null,
        appointmentId: null,
        reason: 'PROVIDER_ILLNESS',
      }),
      409,
    );
    await post(
      'provider',
      `/${workflowId}/close`,
      command(2, {
        proposalId: null,
        appointmentId: id,
        reason: 'PROVIDER_ILLNESS',
        message: 'Cannot take place',
      }),
    );
    expect((await snapshot()).state).toBe('CLOSED');
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({
      cancelledBy: 'PROVIDER',
      cancellationReason: 'PROVIDER_ILLNESS',
    });
  });

  it.each(['decline', 'expiry'] as const)(
    'rejects an empty close after %s without changing workflow, history or outbox',
    async (kind) => {
      const id = getString(await invite(), 'proposalId');
      if (kind === 'decline')
        await post('applicant', `/proposals/${id}/reject`, command(1));
      else {
        now = new Date('2027-01-01T22:00:00Z');
        await post('applicant', `/proposals/${id}/accept`, command(1), 409);
      }
      const before = await prisma.viewingWorkflow.findUniqueOrThrow({
        where: { applicationId },
      });
      const history = await prisma.applicationActivity.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      });
      const events = await prisma.outboxEvent.findMany({
        select: {
          id: true,
          type: true,
          payload: true,
          deduplicationKey: true,
          occurredAt: true,
        },
        where: { applicationId },
        orderBy: { id: 'asc' },
      });
      const view = await snapshot();
      expect(view.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'CLOSE_FLOW',
            allowed: false,
            blockedReason: 'NO_OPEN_VIEWING',
          }),
        ]),
      );
      expect(
        await post(
          'provider',
          `/${before.id}/close`,
          command(before.revision, {
            proposalId: null,
            appointmentId: null,
            reason: 'PROVIDER_OPERATIONAL',
          }),
          409,
        ),
      ).toMatchObject({
        code: 'VIEWING_STATE_CHANGED',
        reason: 'NO_OPEN_VIEWING',
        currentWorkflowRevision: before.revision,
      });
      expect(
        await prisma.viewingWorkflow.findUniqueOrThrow({
          where: { applicationId },
        }),
      ).toEqual(before);
      expect(
        await prisma.applicationActivity.findMany({
          where: { applicationId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(history);
      expect(
        await prisma.outboxEvent.findMany({
          select: {
            id: true,
            type: true,
            payload: true,
            deduplicationKey: true,
            occurredAt: true,
          },
          where: { applicationId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(events);
    },
  );

  it('enforces 18h normal lead time and exact 6h applicant change cutoff', async () => {
    await post(
      'provider',
      '/invitations',
      command(0, schedule('2027-01-02T03:59:59.999Z')),
      400,
    );
    const id = getString(
      await post(
        'provider',
        '/invitations',
        command(0, schedule('2027-01-02T04:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('applicant', `/proposals/${id}/accept`, command(1));
    now = new Date('2027-01-01T21:59:59.999Z');
    const alt = getString(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(2, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    expect(nested(await snapshot(), 'pendingProposal')).toMatchObject({
      timing: 'SHORT_NOTICE',
      responseDeadlineAt: '2027-01-02T04:00:00.000Z',
    });
    await post('applicant', `/proposals/${alt}/withdraw`, command(3));
    now = new Date('2027-01-01T22:00:00.000Z');
    expect(
      await post(
        'applicant',
        `/appointments/${id}/alternative`,
        command(4, schedule('2027-01-04T10:00:00.000Z')),
        409,
      ),
    ).toMatchObject({ reason: 'APPLICANT_CHANGE_CUTOFF_PASSED' });
  });

  it('requires boolean short-notice consent and exposes the shorter deadline', async () => {
    await post(
      'provider',
      '/invitations',
      command(0, {
        ...schedule('2027-01-01T14:00:00.000Z'),
        shortNotice: 'false',
      }),
      400,
    );
    await post(
      'provider',
      '/invitations',
      command(0, {
        ...schedule('2027-01-01T14:00:00.000Z'),
        shortNotice: true,
      }),
    );
    expect(nested(await snapshot(), 'pendingProposal')).toMatchObject({
      timing: 'SHORT_NOTICE',
      responseDeadlineAt: '2027-01-01T14:00:00.000Z',
    });
  });

  it.each(['reject', 'counterproposal'] as const)(
    'serializes accept vs %s from two tabs',
    async (action) => {
      const id = getString(await invite(), 'proposalId');
      const side = action === 'reject' ? 'applicant' : 'provider';
      const responses = await Promise.all([
        applicant.agent
          .post(endpoint('applicant', `/proposals/${id}/accept`))
          .send(command(1)),
        (side === 'applicant' ? applicant : provider).agent
          .post(endpoint(side, `/proposals/${id}/${action}`))
          .send(
            command(
              1,
              action === 'counterproposal'
                ? schedule('2027-01-05T10:00:00.000Z')
                : {},
            ),
          ),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(body(responses.find((r) => r.status === 409)!)).toMatchObject({
        code: 'VIEWING_STATE_CHANGED',
        reason: 'STALE_REVISION',
      });
      expect(
        await prisma.applicationViewing.count({
          where: { applicationId, status: 'ACCEPTED' },
        }),
      ).toBeLessThanOrEqual(1);
      expect(
        await prisma.viewingProposal.count({
          where: { resolution: 'PENDING' },
        }),
      ).toBeLessThanOrEqual(1);
    },
  );

  it('serializes replacement vs cancellation without two commitments or orphaned replacements', async () => {
    const id = await confirmed();
    const responses = await Promise.all([
      provider.agent
        .post(endpoint('provider', `/appointments/${id}/replacement`))
        .send(command(2, schedule('2027-01-05T10:00:00.000Z'))),
      applicant.agent
        .post(endpoint('applicant', `/appointments/${id}/cancel`))
        .send(command(2)),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const w = await snapshot();
    if (w.confirmedAppointment === null) expect(w.pendingProposal).toBeNull();
    else expect(nested(w, 'confirmedAppointment').appointmentId).toBe(id);
  });

  it('materializes expiry exactly once while rejecting competing late commands', async () => {
    const id = getString(await invite(), 'proposalId');
    now = new Date('2027-01-01T22:00:00.000Z');
    const input = command(1);
    expect(
      nested(await snapshot(), 'pendingProposal').acceptanceBlockedReason,
    ).toBe('PROPOSAL_EXPIRED');
    const responses = await Promise.all([
      applicant.agent
        .post(endpoint('applicant', `/proposals/${id}/accept`))
        .send(input),
      provider.agent
        .post(endpoint('provider', `/proposals/${id}/counterproposal`))
        .send(command(1, schedule('2027-01-05T10:00:00.000Z'))),
    ]);
    expect(responses.map((r) => r.status)).toEqual([409, 409]);
    expect(
      (await prisma.viewingProposal.findUniqueOrThrow({ where: { id } }))
        .resolution,
    ).toBe('EXPIRED');
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_PROPOSAL_EXPIRED,
        },
      }),
    ).toBe(1);
    await post(
      'provider',
      '/invitations',
      command(2, schedule('2027-01-05T10:00:00.000Z')),
    );
    await post('applicant', `/proposals/${id}/accept`, input, 409);
    expect((await snapshot()).workflowRevision).toBe(3);
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('ACTIVE');
  });

  it('makes duplicate retries durable, rejects conflicting keys and never retargets old acceptance', async () => {
    const input = command(0, schedule());
    const responses = await Promise.all([
      provider.agent.post(endpoint('provider', '/invitations')).send(input),
      provider.agent.post(endpoint('provider', '/invitations')).send(input),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(body(responses[0])).toEqual(body(responses[1]));
    expect(
      await prisma.viewingCommandReceipt.count({ where: { applicationId } }),
    ).toBe(1);
    await post(
      'provider',
      '/invitations',
      { ...input, ...schedule('2027-01-05T10:00:00.000Z') },
      409,
    );
    const id = getString(body(responses[0]), 'proposalId');
    const accept = command(1);
    const accepted = await post('applicant', `/proposals/${id}/accept`, accept);
    await post(
      'provider',
      `/appointments/${id}/replacement`,
      command(2, schedule('2027-01-05T10:00:00.000Z')),
    );
    expect(await post('applicant', `/proposals/${id}/accept`, accept)).toEqual(
      accepted,
    );
    expect(await snapshot()).toMatchObject({ workflowRevision: 3 });
    expect((await snapshot()).pendingProposal).not.toBeNull();
  });

  it('rejects stale revisions/targets/DTOs and legacy mutation bypass after cutover', async () => {
    const id = getString(await invite(), 'proposalId');
    await post('applicant', `/proposals/${id}/accept`, command(0), 409);
    await post(
      'applicant',
      `/proposals/${randomUUID()}/accept`,
      command(1),
      409,
    );
    await post(
      'applicant',
      `/proposals/${id}/accept`,
      { requestKey: randomUUID(), expectedWorkflowRevision: '1' },
      400,
    );
    await post(
      'applicant',
      `/proposals/${id}/accept`,
      { ...command(1), unknown: true },
      400,
    );
    expect(
      body(
        await applicant.agent
          .patch(path('applicant', `/${id}/accept`))
          .send({})
          .expect(409),
      ),
    ).toMatchObject({ reason: 'WORKFLOW_COMMAND_REQUIRED' });
    expect((await snapshot()).workflowRevision).toBe(1);
  });

  it('blocks the remaining legacy command matrix after cutover without any domain/history/outbox mutation', async () => {
    const id = await legacyProposal();
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    await post('provider', '/reconcile', command(0));
    now = new Date('2027-01-03T10:30:00Z');
    const before = await prisma.viewingWorkflow.findUniqueOrThrow({
      where: { applicationId },
    });
    const ledger = await prisma.applicationViewing.findMany({
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    const history = await prisma.applicationActivity.findMany({
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    const events = await prisma.outboxEvent.findMany({
      select: {
        id: true,
        type: true,
        payload: true,
        deduplicationKey: true,
        occurredAt: true,
      },
      where: { applicationId },
      orderBy: { id: 'asc' },
    });
    const proposal = {
      requestKey: randomUUID(),
      startsAt: '2027-01-06T10:00:00.000Z',
      endsAt: '2027-01-06T10:30:00.000Z',
      timeZone: 'Europe/Berlin',
    };
    const requests = [
      () => provider.agent.post(path('provider')).send(proposal),
      () =>
        provider.agent
          .post(path('provider', `/${id}/reschedule`))
          .send(proposal),
      ...['cancel', 'complete', 'no-show'].map(
        (action) => () =>
          provider.agent.patch(path('provider', `/${id}/${action}`)).send({}),
      ),
      () =>
        provider.agent
          .patch(path('provider', `/${id}/correct-outcome`))
          .send({ outcome: 'COMPLETED', reason: 'Must use current command' }),
      () => applicant.agent.patch(path('applicant', `/${id}/decline`)).send({}),
      () =>
        applicant.agent
          .patch(path('applicant', `/${id}/request-another-time`))
          .send({ message: 'Must use current proposal' }),
      () =>
        applicant.agent
          .patch(path('applicant', `/${id}/interest`))
          .send({ interest: 'NOT_INTERESTED', confirmWithdrawal: true }),
    ];
    for (const send of requests)
      expect(body(await send().expect(409))).toMatchObject({
        code: 'VIEWING_STATE_CHANGED',
        reason: 'WORKFLOW_COMMAND_REQUIRED',
      });
    expect(
      await prisma.viewingWorkflow.findUniqueOrThrow({
        where: { applicationId },
      }),
    ).toEqual(before);
    expect(
      await prisma.applicationViewing.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(ledger);
    expect(
      await prisma.applicationActivity.findMany({
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(history);
    expect(
      await prisma.outboxEvent.findMany({
        select: {
          id: true,
          type: true,
          payload: true,
          deduplicationKey: true,
          occurredAt: true,
        },
        where: { applicationId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(events);
  });

  it('preserves role, ownership and WAITING privacy', async () => {
    await applicant.agent
      .post(endpoint('provider', '/invitations'))
      .send(command(0, schedule()))
      .expect(403);
    await provider.agent
      .post(endpoint('applicant', '/reconcile'))
      .send(command(0))
      .expect(403);
    const outsider = await register('provider');
    await outsider.agent.get(endpoint('provider')).expect(404);
    await outsider.agent
      .post(endpoint('provider', '/invitations'))
      .send(command(0, schedule()))
      .expect(404);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING, activeAt: null },
    });
    await provider.agent.get(endpoint('provider')).expect(404);
    await post('provider', '/invitations', command(0, schedule()), 404);
    await post('applicant', '/reconcile', command(0), 409);
  });

  it('rolls back invalid counterproposal and failed history without partial rejection or receipts', async () => {
    const id = getString(await invite(), 'proposalId');
    const alt = getString(
      await post(
        'applicant',
        `/proposals/${id}/alternative`,
        command(1, schedule('2027-01-04T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post(
      'provider',
      `/proposals/${alt}/counterproposal`,
      command(2, schedule('2026-01-01T10:00:00.000Z')),
      400,
    );
    jest
      .spyOn(app.get(ApplicationActivityService), 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('command activity failed'));
    await post('provider', `/proposals/${alt}/reject`, command(2), 500);
    expect(
      (await prisma.viewingProposal.findUniqueOrThrow({ where: { id: alt } }))
        .resolution,
    ).toBe('PENDING');
    expect((await snapshot()).workflowRevision).toBe(2);
    expect(
      await prisma.viewingCommandReceipt.count({ where: { applicationId } }),
    ).toBe(2);
  });

  it('reconciles stale legacy snapshots and newly written rounds without inventing history/deadlines', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    const s = schedule('2027-01-05T10:00:00.000Z');
    const next = getString(
      body(
        await provider.agent
          .post(path('provider', `/${id}/reschedule`))
          .send({
            requestKey: randomUUID(),
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            timeZone: s.timeZone,
          })
          .expect(201),
      ),
      'viewingId',
    );
    await applicant.agent
      .patch(path('applicant', `/${next}/accept`))
      .send({})
      .expect(200);
    const before = await prisma.applicationActivity.count({
      where: { applicationId },
    });
    expect(await snapshot()).toMatchObject({
      mode: 'LEGACY',
      pendingProposal: null,
      confirmedAppointment: null,
    });
    await post('provider', '/invitations', command(0, schedule()), 409);
    const input = command(0);
    const reconciled = await post('provider', '/reconcile', input);
    expect(reconciled.workflowRevision).toBe(1);
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      next,
    );
    expect(await prisma.viewingAppointment.count()).toBe(2);
    expect(
      await prisma.viewingProposal.count({
        where: { timing: 'LEGACY', responseDeadlineAt: null },
      }),
    ).toBe(2);
    expect(
      await prisma.applicationActivity.count({ where: { applicationId } }),
    ).toBe(before);
    expect(await post('provider', '/reconcile', input)).toEqual(reconciled);
  });

  it('requires explicit reissue before accepting an undated legacy invitation', async () => {
    const id = await legacyProposal();
    await post('applicant', '/reconcile', command(0));
    expect(
      await post('applicant', `/proposals/${id}/accept`, command(1), 409),
    ).toMatchObject({ reason: 'LEGACY_INVITATION_REQUIRES_REISSUE' });
    const next = getString(
      await post(
        'provider',
        `/proposals/${id}/counterproposal`,
        command(1, schedule('2027-01-05T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post('applicant', `/proposals/${next}/accept`, command(2));
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('SUPERSEDED');
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      next,
    );
  });

  it('does not expire a newer proposal when given an obsolete exact target', async () => {
    const id = getString(await invite(), 'proposalId');
    const next = getString(
      await post(
        'provider',
        `/proposals/${id}/counterproposal`,
        command(1, schedule('2027-01-05T10:00:00.000Z')),
      ),
      'proposalId',
    );
    now = new Date('2027-01-01T22:00:00Z');
    expect(
      await post('applicant', `/proposals/${id}/accept`, command(2), 409),
    ).toMatchObject({ reason: 'PROPOSAL_IS_NOT_CURRENT' });
    expect((await snapshot()).workflowRevision).toBe(2);
    expect(
      (await prisma.viewingProposal.findUniqueOrThrow({ where: { id: next } }))
        .resolution,
    ).toBe('PENDING');
  });

  it('closes a pending replacement on applicant cancellation and preserves both histories', async () => {
    const id = await confirmed();
    const next = getString(
      await post(
        'provider',
        `/appointments/${id}/replacement`,
        command(2, schedule('2027-01-05T10:00:00.000Z')),
      ),
      'proposalId',
    );
    await post(
      'applicant',
      `/appointments/${id}/cancel`,
      command(3, { message: 'Unable to attend' }),
    );
    expect(await snapshot()).toMatchObject({
      workflowRevision: 4,
      pendingProposal: null,
      confirmedAppointment: null,
    });
    expect(
      (await prisma.viewingProposal.findUniqueOrThrow({ where: { id: next } }))
        .resolution,
    ).toBe('CLOSED');
    expect(
      await prisma.viewingAppointment.findUniqueOrThrow({
        where: { viewingId: id },
      }),
    ).toMatchObject({
      cancelledBy: 'APPLICANT',
      cancellationNote: 'Unable to attend',
    });
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('ACTIVE');
  });

  it('rejects a same-time applicant alternative without changing the invitation', async () => {
    const id = getString(await invite(), 'proposalId');
    await post(
      'applicant',
      `/proposals/${id}/alternative`,
      command(1, schedule()),
      400,
    );
    expect(await snapshot()).toMatchObject({ workflowRevision: 1 });
    expect(nested(await snapshot(), 'pendingProposal').proposalId).toBe(id);
  });

  it('makes an expiry failure receipt durable after subsequent invitations', async () => {
    const id = getString(await invite(), 'proposalId');
    now = new Date('2027-01-01T22:00:00Z');
    const input = command(1);
    const expired = await post(
      'applicant',
      `/proposals/${id}/accept`,
      input,
      409,
    );
    expect(expired).toMatchObject({
      reason: 'PROPOSAL_EXPIRED',
      currentWorkflowRevision: 2,
    });
    await post(
      'provider',
      '/invitations',
      command(2, schedule('2027-01-05T10:00:00.000Z')),
    );
    expect(
      await post('applicant', `/proposals/${id}/accept`, input, 409),
    ).toEqual(expired);
    expect((await snapshot()).workflowRevision).toBe(3);
  });

  it('replays canonical retries after application mutation is disabled, without bypassing authorization', async () => {
    const input = command(0, schedule());
    const result = await post('provider', '/invitations', input);
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: 'REJECTED',
        rejectedAt: now,
        publicReason: 'NOT_SELECTED',
      },
    });
    expect(
      await post('provider', '/invitations', {
        ...input,
        startsAt: '2027-01-03T11:00:00+01:00',
      }),
    ).toEqual(result);
    expect(
      await post('provider', '/invitations', command(1, schedule()), 409),
    ).toMatchObject({
      reason: 'APPLICATION_PROCESS_INACTIVE',
      currentWorkflowRevision: 1,
    });
  });

  it('fails reconciliation closed when the resulting projection is inconsistent', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    await prisma.viewingWorkflow.update({
      where: { applicationId },
      data: {
        revision: { increment: 1 },
        providerConsideration: 'DO_NOT_CONTINUE',
        considerationDecidedAt: now,
      },
    });
    expect(await post('provider', '/reconcile', command(1), 409)).toMatchObject(
      {
        code: 'VIEWING_STATE_CHANGED',
        reason: 'LEGACY_RECONCILIATION_FAILED',
        currentWorkflowRevision: 1,
      },
    );
    expect(await snapshot()).toMatchObject({
      mode: 'LEGACY',
      workflowRevision: 1,
      reconciliationRequired: true,
    });
    expect(
      await prisma.viewingCommandReceipt.count({ where: { applicationId } }),
    ).toBe(0);
  });

  it('serializes legacy reconciliation vs new command', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
    const responses = await Promise.all([
      provider.agent.post(endpoint('provider', '/reconcile')).send(command(0)),
      provider.agent
        .post(endpoint('provider', `/appointments/${id}/replacement`))
        .send(command(1, schedule('2027-01-05T10:00:00.000Z'))),
    ]);
    expect(responses[0].status).toBe(200);
    expect([200, 409]).toContain(responses[1].status);
    expect(nested(await snapshot(), 'confirmedAppointment').appointmentId).toBe(
      id,
    );
    expect((await snapshot()).mode).toBe('CURRENT');
  });

  it('serializes legacy writers vs reconciliation and blocks them after cutover', async () => {
    const id = await legacyProposal();
    await legacySnapshot(id);
    const responses = await Promise.all([
      provider.agent.post(endpoint('provider', '/reconcile')).send(command(0)),
      applicant.agent.patch(path('applicant', `/${id}/accept`)).send({}),
    ]);
    expect(responses[0].status).toBe(200);
    expect([200, 409]).toContain(responses[1].status);
    const w = await snapshot();
    if (responses[1].status === 200)
      expect(nested(w, 'confirmedAppointment').appointmentId).toBe(id);
    else expect(nested(w, 'pendingProposal').proposalId).toBe(id);
    expect(w.mode).toBe('CURRENT');
  });
});
