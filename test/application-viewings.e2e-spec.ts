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

describe('Application viewings E2E', () => {
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
    await prisma.$executeRaw`TRUNCATE TABLE application_viewing_interests, application_viewing_outcomes, application_viewings`;
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

  function proposal(requestKey = randomUUID()) {
    return {
      requestKey,
      startsAt: '2027-01-01T12:00:00+01:00',
      endsAt: '2027-01-01T12:30:00+01:00',
      timeZone: 'Europe/Berlin',
      providerNote: '  Treffpunkt Hauseingang  ',
    };
  }

  async function propose() {
    return getString(
      body(
        await provider.agent
          .post(path('provider'))
          .send(proposal())
          .expect(201),
      ),
      'viewingId',
    );
  }

  async function accept(id: string) {
    return applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(200);
  }

  it('exposes safe current/history semantics and a complete change-request workflow', async () => {
    expect(
      body(await provider.agent.get(path('provider')).expect(200)),
    ).toMatchObject({
      currentViewing: null,
      latestViewing: null,
      canPropose: true,
      nextAction: 'NONE',
    });
    const id = await propose();
    const change = body(
      await applicant.agent
        .patch(path('applicant', `/${id}/request-another-time`))
        .send({ message: '  Dienstag ab 16 Uhr  ' })
        .expect(200),
    );
    expect(change).toMatchObject({
      status: 'CHANGE_REQUESTED',
      changeRequestMessage: 'Dienstag ab 16 Uhr',
      nextAction: 'PROVIDER_RESPOND_TO_CHANGE_REQUEST',
      startsAt: '2027-01-01T11:00:00.000Z',
    });
    await applicant.agent
      .patch(path('applicant', `/${id}/request-another-time`))
      .send({ message: 'Dienstag ab 16 Uhr' })
      .expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(409);
    const page = body(await provider.agent.get(path('provider')).expect(200));
    expect(page).toMatchObject({
      currentViewing: null,
      changeRequestedViewing: { viewingId: id },
      canPropose: true,
      nextAction: 'PROVIDER_RESPOND_TO_CHANGE_REQUEST',
    });
    const next = await propose();
    expect(
      body(
        await applicant.agent.get(path('applicant', `/${next}`)).expect(200),
      ),
    ).toMatchObject({
      round: 2,
      status: 'PROPOSED',
      canAccept: true,
      nextAction: 'APPLICANT_RESPOND_TO_VIEWING',
    });
    const history = JSON.stringify(
      body(await provider.agent.get(path('provider')).expect(200)),
    );
    for (const field of [
      'requestHash',
      'requestKey',
      'applicantId',
      'providerId',
      'passwordHash',
      'householdNetIncome',
    ])
      expect(history).not.toContain(field);
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_CHANGE_REQUESTED,
        },
      }),
    ).toBe(1);
  });

  it('requires fresh acceptance after reschedule and retains original proposal and acceptance', async () => {
    const id = await propose();
    await accept(id);
    const data = {
      ...proposal(),
      startsAt: '2027-01-02T12:00:00+01:00',
      endsAt: '2027-01-02T12:30:00+01:00',
    };
    const next = body(
      await provider.agent
        .post(path('provider', `/${id}/reschedule`))
        .send(data)
        .expect(201),
    );
    expect(next).toMatchObject({
      round: 2,
      status: 'PROPOSED',
      acceptedAt: null,
    });
    expect(
      body(await applicant.agent.get(path('applicant', `/${id}`)).expect(200)),
    ).toMatchObject({
      status: 'SUPERSEDED',
      startsAt: '2027-01-01T11:00:00.000Z',
      canAccept: false,
    });
    await applicant.agent
      .patch(path('applicant', `/${id}/decline`))
      .send({})
      .expect(409);
    now = new Date('2027-01-03T10:00:00Z');
    expect(
      body(
        await provider.agent
          .post(path('provider', `/${id}/reschedule`))
          .send(data)
          .expect(201),
      ).viewingId,
    ).toBe(next.viewingId);
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_RESCHEDULED,
        },
      }),
    ).toBe(1);
  });

  it('makes proposal retries durable and rejects conflicting keys and unresolved duplicates', async () => {
    const data = proposal();
    const responses = await Promise.all([
      provider.agent.post(path('provider')).send(data),
      provider.agent.post(path('provider')).send(data),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(body(responses[0]).viewingId).toBe(body(responses[1]).viewingId);
    await provider.agent
      .post(path('provider'))
      .send({ ...data, providerNote: 'different' })
      .expect(409);
    await provider.agent.post(path('provider')).send(proposal()).expect(409);
    expect(
      await prisma.applicationViewing.count({ where: { applicationId } }),
    ).toBe(1);
    expect(
      await prisma.applicationActivity.count({ where: { applicationId } }),
    ).toBe(1);
  });

  it('serializes distinct-key double proposals and allows group viewings across applications', async () => {
    const results = await Promise.all([
      provider.agent.post(path('provider')).send(proposal()),
      provider.agent.post(path('provider')).send(proposal()),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const secondApplicant = await register('applicant');
    const secondApplication = await prisma.application.create({
      data: {
        listingId,
        applicantId: secondApplicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      },
    });
    await provider.agent
      .post(`/api/v1/provider/applications/${secondApplication.id}/viewings`)
      .send(proposal())
      .expect(201);
    expect(
      await prisma.applicationViewing.count({
        where: { application: { listingId } },
      }),
    ).toBe(2);
  });

  it('enforces role, ownership, cross-application IDs and WAITING privacy on every surface', async () => {
    const id = await propose();
    const foreignProvider = await register('provider');
    const foreignApplicant = await register('applicant');
    await foreignProvider.agent.get(path('provider')).expect(404);
    await foreignProvider.agent
      .post(path('provider'))
      .send(proposal())
      .expect(404);
    await foreignApplicant.agent.get(path('applicant', `/${id}`)).expect(404);
    await foreignApplicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(404);
    await applicant.agent.post(path('provider')).send(proposal()).expect(403);
    const other = await prisma.application.create({
      data: {
        listingId,
        applicantId: foreignApplicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      },
    });
    await provider.agent
      .get(`/api/v1/provider/applications/${other.id}/viewings/${id}`)
      .expect(404);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING },
    });
    await provider.agent.get(path('provider')).expect(404);
    await provider.agent.get(path('provider', `/${id}`)).expect(404);
    await provider.agent.post(path('provider')).send(proposal()).expect(404);
    await provider.agent
      .patch(path('provider', `/${id}/cancel`))
      .send({})
      .expect(404);
    await applicant.agent.get(path('applicant')).expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(409);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED, activeAt: null },
    });
    await provider.agent.get(path('provider')).expect(404);
  });

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])(
    'freezes %s history and resumes future proposals on ACTIVE restoration',
    async (status) => {
      const id = await propose();
      await prisma.application.update({
        where: { id: applicationId },
        data: { status },
      });
      expect(
        body(await provider.agent.get(path('provider', `/${id}`)).expect(200)),
      ).toMatchObject({
        nextAction: 'NONE',
        canCancel: false,
        mutationsBlockedReason: 'APPLICATION_PROCESS_INACTIVE',
      });
      await provider.agent
        .patch(path('provider', `/${id}/cancel`))
        .send({})
        .expect(409);
      await applicant.agent
        .patch(path('applicant', `/${id}/accept`))
        .send({})
        .expect(409);
      await prisma.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.ACTIVE },
      });
      await accept(id);
    },
  );

  it('permits PAUSED appointments but freezes RENTED listings', async () => {
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.PAUSED },
    });
    const id = await propose();
    await accept(id);
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.RENTED },
    });
    await provider.agent
      .patch(path('provider', `/${id}/cancel`))
      .send({})
      .expect(409);
    await provider.agent.get(path('provider', `/${id}`)).expect(200);
  });

  it('rejects past input, direct applicant schedule edits and unsafe text', async () => {
    await provider.agent
      .post(path('provider'))
      .send({
        ...proposal(),
        startsAt: '2026-01-01T10:00:00Z',
        endsAt: '2026-01-01T10:30:00Z',
      })
      .expect(400);
    await provider.agent
      .post(path('provider'))
      .send({ ...proposal(), startsAt: '2027-01-01T12:00:00' })
      .expect(400);
    await provider.agent
      .post(path('provider'))
      .send({ ...proposal(), providerNote: 123 })
      .expect(400);
    const id = await propose();
    await applicant.agent
      .patch(path('applicant', `/${id}/request-another-time`))
      .send({ startsAt: '2027-01-02T12:00:00Z' })
      .expect(400);
    await applicant.agent
      .patch(path('applicant', `/${id}/request-another-time`))
      .send({ message: '<script>' })
      .expect(400);
    await applicant.agent
      .patch(path('applicant', `/${id}/request-another-time`))
      .send({ message: 'a'.repeat(501) })
      .expect(400);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({ status: 'COMPLETED' })
      .expect(400);
  });

  it('supports final decline, provider cancellation and explicit overdue handling', async () => {
    const id = await propose();
    await accept(id);
    await applicant.agent
      .patch(path('applicant', `/${id}/decline`))
      .send({})
      .expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/decline`))
      .send({})
      .expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(409);
    const unanswered = await propose();
    now = new Date('2027-01-01T11:30:00Z');
    expect(
      body(
        await provider.agent
          .get(path('provider', `/${unanswered}`))
          .expect(200),
      ),
    ).toMatchObject({
      isOverdue: true,
      nextAction: 'PROVIDER_CLOSE_UNANSWERED_VIEWING',
      canMarkNoShow: false,
    });
    await provider.agent
      .patch(path('provider', `/${unanswered}/cancel`))
      .send({})
      .expect(200);
    await provider.agent
      .patch(path('provider', `/${unanswered}/cancel`))
      .send({})
      .expect(200);
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_CANCELLED,
        },
      }),
    ).toBe(1);
  });

  it('records completed outcome then final idempotent applicant interest', async () => {
    const id = await propose();
    await applicant.agent
      .patch(path('applicant', `/${id}/interest`))
      .send({ interest: 'STILL_INTERESTED' })
      .expect(409);
    await accept(id);
    await provider.agent
      .patch(path('provider', `/${id}/complete`))
      .send({})
      .expect(409);
    now = new Date('2027-01-01T11:30:00Z');
    const completed = body(
      await provider.agent
        .patch(path('provider', `/${id}/complete`))
        .send({})
        .expect(200),
    );
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      nextAction: 'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
    });
    await provider.agent
      .patch(path('provider', `/${id}/complete`))
      .send({})
      .expect(200);
    await provider.agent
      .patch(path('provider', `/${id}/no-show`))
      .send({})
      .expect(409);
    expect(
      body(
        await applicant.agent
          .patch(path('applicant', `/${id}/interest`))
          .send({ interest: 'STILL_INTERESTED' })
          .expect(200),
      ),
    ).toMatchObject({
      interest: { interest: 'STILL_INTERESTED' },
      nextAction: 'NONE',
    });
    await applicant.agent
      .patch(path('applicant', `/${id}/interest`))
      .send({ interest: 'STILL_INTERESTED' })
      .expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/interest`))
      .send({ interest: 'NOT_INTERESTED' })
      .expect(409);
    await provider.agent
      .patch(path('provider', `/${id}/correct-outcome`))
      .send({ outcome: 'NO_SHOW', reason: 'Wrong selection' })
      .expect(409);
    expect(
      body(await provider.agent.get(path('provider')).expect(200)),
    ).toMatchObject({
      currentViewing: null,
      latestCompletedViewing: { viewingId: id },
      pendingInterestViewing: null,
    });
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_INTEREST_CONFIRMED,
        },
      }),
    ).toBe(1);
  });

  it('preserves original outcome when corrected, limits corrections and rejects interest after NO_SHOW', async () => {
    const id = await propose();
    await accept(id);
    now = new Date('2027-01-01T11:30:00Z');
    await provider.agent
      .patch(path('provider', `/${id}/no-show`))
      .send({})
      .expect(200);
    await applicant.agent
      .patch(path('applicant', `/${id}/interest`))
      .send({ interest: 'NOT_INTERESTED' })
      .expect(409);
    const correction = {
      outcome: 'COMPLETED',
      reason: '  Attendance confirmed  ',
    };
    const corrected = body(
      await provider.agent
        .patch(path('provider', `/${id}/correct-outcome`))
        .send(correction)
        .expect(200),
    );
    expect(corrected).toMatchObject({
      status: 'COMPLETED',
      outcomes: [
        { revision: 1, outcome: 'NO_SHOW', correctionReason: null },
        {
          revision: 2,
          outcome: 'COMPLETED',
          correctionReason: 'Attendance confirmed',
        },
      ],
    });
    await provider.agent
      .patch(path('provider', `/${id}/correct-outcome`))
      .send(correction)
      .expect(200);
    await provider.agent
      .patch(path('provider', `/${id}/correct-outcome`))
      .send({ outcome: 'NO_SHOW', reason: 'again' })
      .expect(409);
    await applicant.agent
      .patch(path('applicant', `/${id}/interest`))
      .send({ interest: 'NOT_INTERESTED' })
      .expect(200);
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_OUTCOME_CORRECTED,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.applicationActivity.count({
        where: {
          applicationId,
          type: ApplicationActivityType.VIEWING_INTEREST_DECLINED,
        },
      }),
    ).toBe(1);
  });

  it('enforces correction cutoff and guards no-show against interest races', async () => {
    const id = await propose();
    await accept(id);
    now = new Date('2027-01-01T11:30:00Z');
    await provider.agent
      .patch(path('provider', `/${id}/complete`))
      .send({})
      .expect(200);
    const results = await Promise.all([
      provider.agent
        .patch(path('provider', `/${id}/correct-outcome`))
        .send({ outcome: 'NO_SHOW', reason: 'Mistaken attendance' }),
      applicant.agent
        .patch(path('applicant', `/${id}/interest`))
        .send({ interest: 'STILL_INTERESTED' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const effective = await prisma.applicationViewing.findUniqueOrThrow({
      where: { id },
      include: { interest: true },
    });
    expect(
      effective.status === 'NO_SHOW'
        ? effective.interest === null
        : effective.interest !== null,
    ).toBe(true);
    now = new Date('2027-01-02T11:30:00Z');
    await provider.agent
      .patch(path('provider', `/${id}/correct-outcome`))
      .send({
        outcome: effective.status === 'NO_SHOW' ? 'COMPLETED' : 'NO_SHOW',
        reason: 'Too late',
      })
      .expect(409);
  });

  it('serializes accept against reschedule, change request and cancellation', async () => {
    const id = await propose();
    const responses = await Promise.all([
      applicant.agent.patch(path('applicant', `/${id}/accept`)).send({}),
      provider.agent
        .post(path('provider', `/${id}/reschedule`))
        .send(proposal()),
    ]);
    expect(responses[1].status).toBe(201);
    expect([200, 409]).toContain(responses[0].status);
    const replacementId = getString(body(responses[1]), 'viewingId');
    const second = await Promise.all([
      applicant.agent
        .patch(path('applicant', `/${replacementId}/request-another-time`))
        .send({ message: 'Monday' }),
      provider.agent
        .patch(path('provider', `/${replacementId}/cancel`))
        .send({}),
    ]);
    expect(second.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await prisma.applicationViewing.count({
        where: { applicationId, status: { in: ['PROPOSED', 'ACCEPTED'] } },
      }),
    ).toBe(0);
  });

  it('serializes opposing outcomes and makes double completion exactly once', async () => {
    const id = await propose();
    await accept(id);
    now = new Date('2027-01-01T11:30:00Z');
    const results = await Promise.all([
      provider.agent.patch(path('provider', `/${id}/complete`)).send({}),
      provider.agent.patch(path('provider', `/${id}/no-show`)).send({}),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await prisma.applicationViewingOutcome.count({
        where: { viewingId: id },
      }),
    ).toBe(1);
    const outcome = await prisma.applicationViewingOutcome.findFirstOrThrow({
      where: { viewingId: id },
    });
    const suffix = outcome.outcome === 'COMPLETED' ? 'complete' : 'no-show';
    await Promise.all([
      provider.agent
        .patch(path('provider', `/${id}/${suffix}`))
        .send({})
        .expect(200),
      provider.agent
        .patch(path('provider', `/${id}/${suffix}`))
        .send({})
        .expect(200),
    ]);
    expect(
      await prisma.applicationViewingOutcome.count({
        where: { viewingId: id },
      }),
    ).toBe(1);
  });

  it('serializes acceptance against real application withdrawal and freezes resulting history', async () => {
    const id = await propose();
    const results = await Promise.all([
      applicant.agent.patch(path('applicant', `/${id}/accept`)).send({}),
      applicant.agent.delete(`/api/v1/applicant/applications/${applicationId}`),
    ]);
    expect(results[1].status).toBe(200);
    expect([200, 409]).toContain(results[0].status);
    expect(
      (
        await prisma.application.findUniqueOrThrow({
          where: { id: applicationId },
        })
      ).status,
    ).toBe('WITHDRAWN');
    const row = body(
      await provider.agent.get(path('provider', `/${id}`)).expect(200),
    );
    expect(row).toMatchObject({
      nextAction: 'NONE',
      canCancel: false,
      canReschedule: false,
    });
    expect(row.status).toBe(
      results[0].status === 200 ? 'ACCEPTED' : 'PROPOSED',
    );
    const events = await prisma.applicationActivity.findMany({
      where: { applicationId },
    });
    expect(
      events.filter(
        (event) => event.type === ApplicationActivityType.APPLICATION_WITHDRAWN,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === ApplicationActivityType.VIEWING_ACCEPTED,
      ),
    ).toHaveLength(results[0].status === 200 ? 1 : 0);
    await applicant.agent
      .patch(path('applicant', `/${id}/accept`))
      .send({})
      .expect(409);
    await provider.agent.post(path('provider')).send(proposal()).expect(409);
    expect(
      await prisma.applicationActivity.count({ where: { applicationId } }),
    ).toBe(events.length);
  });

  it('serializes cancellation against accepted responses and outcomes', async () => {
    const id = await propose();
    const first = await Promise.all([
      applicant.agent.patch(path('applicant', `/${id}/accept`)).send({}),
      provider.agent.patch(path('provider', `/${id}/cancel`)).send({}),
    ]);
    expect(first[1].status).toBe(200);
    expect([200, 409]).toContain(first[0].status);
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('CANCELLED');
    const next = await propose();
    await accept(next);
    now = new Date('2027-01-01T11:30:00Z');
    const second = await Promise.all([
      provider.agent.patch(path('provider', `/${next}/complete`)).send({}),
      provider.agent.patch(path('provider', `/${next}/cancel`)).send({}),
    ]);
    expect(second.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const effective = await prisma.applicationViewing.findUniqueOrThrow({
      where: { id: next },
      include: { outcomes: true },
    });
    expect(effective.outcomes).toHaveLength(
      effective.status === 'COMPLETED' ? 1 : 0,
    );
  });

  it('serializes change requests against rescheduling and double applicant responses', async () => {
    const id = await propose();
    const first = await Promise.all([
      applicant.agent
        .patch(path('applicant', `/${id}/request-another-time`))
        .send({ message: 'Monday afternoon' }),
      provider.agent
        .post(path('provider', `/${id}/reschedule`))
        .send(proposal()),
    ]);
    expect(first.map((response) => response.status).sort()).toEqual(
      first[1].status === 201 ? [201, 409] : [200, 409],
    );
    const current =
      first[1].status === 201
        ? getString(body(first[1]), 'viewingId')
        : await propose();
    const second = await Promise.all([
      applicant.agent.patch(path('applicant', `/${current}/accept`)).send({}),
      applicant.agent
        .patch(path('applicant', `/${current}/request-another-time`))
        .send({}),
    ]);
    expect([200, 409]).toContain(second[0].status);
    expect(second[1].status).toBe(200);
    expect(
      (
        await prisma.applicationViewing.findUniqueOrThrow({
          where: { id: current },
        })
      ).status,
    ).toBe('CHANGE_REQUESTED');
  });

  it('rolls back proposal/reschedule and activity together', async () => {
    const activity = app.get(ApplicationActivityService);
    const failure = jest
      .spyOn(activity, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('test event failure'));
    await provider.agent.post(path('provider')).send(proposal()).expect(500);
    expect(
      await prisma.applicationViewing.count({ where: { applicationId } }),
    ).toBe(0);
    expect(
      await prisma.applicationActivity.count({ where: { applicationId } }),
    ).toBe(0);
    failure.mockRestore();
    const id = await propose();
    jest
      .spyOn(activity, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('test reschedule failure'));
    await provider.agent
      .post(path('provider', `/${id}/reschedule`))
      .send(proposal())
      .expect(500);
    expect(
      await prisma.applicationViewing.count({ where: { applicationId } }),
    ).toBe(1);
    expect(
      (await prisma.applicationViewing.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe('PROPOSED');
  });
});
