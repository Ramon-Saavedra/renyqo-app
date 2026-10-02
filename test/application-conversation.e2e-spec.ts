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
import { AppModule } from '../src/app.module';
import { ApplicationActivityService } from '../src/applications/application-activity.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationStatus,
  ApplicationActivityType,
  ListingStatus,
  Role,
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

describe('Application conversation E2E', () => {
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
    return `/api/v1/${side}/applications/${applicationId}/conversation${suffix}`;
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

  async function open() {
    return provider.agent
      .post(path('provider', '/messages'))
      .send({ body: '  Hallo\nGrüße  ' })
      .expect(201);
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
    }).compile();
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

  it('starts closed, denies applicant initiation and opens atomically with the first provider message', async () => {
    const closed = body(
      await applicant.agent.get(path('applicant')).expect(200),
    );
    expect(closed).toMatchObject({
      applicationId,
      conversationId: null,
      isOpen: false,
      canCurrentUserSend: false,
      expectedResponder: 'PROVIDER',
      unreadCount: 0,
      messages: [],
    });
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Hello' })
      .expect(409);
    expect(await prisma.applicationConversation.count()).toBe(0);
    const message = body(await open());
    expect(message).toMatchObject({
      sequence: 1,
      senderType: 'PROVIDER',
      body: 'Hallo\nGrüße',
      readAt: null,
    });
    expect(await prisma.applicationConversation.count()).toBe(1);
    expect(await prisma.applicationMessage.count()).toBe(1);
    const events = await prisma.applicationActivity.findMany({
      where: { applicationId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((event) => event.type).sort()).toEqual(
      [
        ApplicationActivityType.CONVERSATION_OPENED,
        ApplicationActivityType.MESSAGE_SENT,
      ].sort(),
    );
    expect(
      events.every(
        (event) => event.payload === null && event.visibility === 'BOTH',
      ),
    ).toBe(true);
  });

  it('enforces alternating turns and separates unread counts from own sent messages', async () => {
    await open();
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Again' })
      .expect(409);
    expect(
      body(await provider.agent.get(path('provider', '/summary')).expect(200)),
    ).toMatchObject({ unreadCount: 0, canCurrentUserSend: false });
    expect(
      body(
        await applicant.agent.get(path('applicant', '/summary')).expect(200),
      ),
    ).toMatchObject({
      unreadCount: 1,
      canCurrentUserSend: true,
      expectedResponder: 'APPLICANT',
    });
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Reply' })
      .expect(201);
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Again' })
      .expect(409);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Next' })
      .expect(201);
    const summary = body(
      await applicant.agent.get(path('applicant', '/summary')).expect(200),
    );
    expect(summary).toMatchObject({
      unreadCount: 2,
      lastMessage: { sequence: 3, senderType: 'PROVIDER', body: 'Next' },
    });
  });

  it.each(['provider', 'applicant'] as const)(
    'serializes simultaneous %s sends in PostgreSQL',
    async (side) => {
      if (side === 'applicant') await open();
      const agent = side === 'provider' ? provider.agent : applicant.agent;
      const responses = await Promise.all([
        agent.post(path(side, '/messages')).send({ body: 'First race' }),
        agent.post(path(side, '/messages')).send({ body: 'Second race' }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(await prisma.applicationConversation.count()).toBe(1);
      expect(await prisma.applicationMessage.count()).toBe(
        side === 'provider' ? 1 : 2,
      );
    },
  );

  it('marks only incoming messages through the observed cutoff and preserves later unread messages', async () => {
    await open();
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Reply' })
      .expect(201);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Later' })
      .expect(201);
    expect(
      body(
        await applicant.agent
          .patch(path('applicant', '/read'))
          .send({ throughSequence: 1 })
          .expect(200),
      ),
    ).toEqual({ markedCount: 1 });
    expect(
      body(
        await applicant.agent
          .patch(path('applicant', '/read'))
          .send({ throughSequence: 1 })
          .expect(200),
      ),
    ).toEqual({ markedCount: 0 });
    expect(
      body(
        await applicant.agent.get(path('applicant', '/summary')).expect(200),
      ),
    ).toHaveProperty('unreadCount', 1);
    const rows = await prisma.applicationMessage.findMany({
      orderBy: { sequence: 'asc' },
    });
    expect(rows[0]?.readAt).toBeInstanceOf(Date);
    expect(rows[1]?.readAt).toBeNull();
    expect(rows[2]?.readAt).toBeNull();
    expect(
      body(
        await provider.agent
          .patch(path('provider', '/read'))
          .send({ throughSequence: 3 })
          .expect(200),
      ),
    ).toEqual({ markedCount: 1 });
    await applicant.agent
      .patch(path('applicant', '/read'))
      .send({ throughSequence: 4 })
      .expect(400);
  });

  it('orders tied timestamps by sequence and paginates without leaking internal fields', async () => {
    await open();
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Reply' })
      .expect(201);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Third' })
      .expect(201);
    await prisma.applicationMessage.updateMany({
      data: { createdAt: new Date('2026-10-02T12:00:00Z') },
    });
    const first = body(
      await applicant.agent
        .get(path('applicant'))
        .query({ limit: 2 })
        .expect(200),
    );
    expect(first).toMatchObject({
      hasMore: true,
      nextAfterSequence: 2,
      messages: [{ sequence: 1 }, { sequence: 2 }],
      lastMessage: { sequence: 3 },
    });
    const second = body(
      await applicant.agent
        .get(path('applicant'))
        .query({ afterSequence: 2, limit: 2 })
        .expect(200),
    );
    expect(second).toMatchObject({
      hasMore: false,
      nextAfterSequence: null,
      messages: [{ sequence: 3 }],
    });
    const serialized = JSON.stringify(first);
    for (const privateField of [
      'applicantId',
      'providerId',
      'senderUserId',
      'passwordHash',
      'email',
      'profile',
      'actorUserId',
    ]) {
      expect(serialized).not.toContain(privateField);
    }
  });

  it.each(['', ' \n\t ', 'x'.repeat(4001), '<b>HTML</b>', 'hello\u0000'])(
    'rejects invalid messages without creating conversation or activity',
    async (text) => {
      await provider.agent
        .post(path('provider', '/messages'))
        .send({ body: text })
        .expect(400);
      expect(await prisma.applicationConversation.count()).toBe(0);
      expect(await prisma.applicationActivity.count()).toBe(0);
    },
  );

  it('accepts 4000 plain text characters and rejects attachments', async () => {
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Hello', attachment: 'file' })
      .expect(400);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'x'.repeat(4000) })
      .expect(201);
    expect(
      (await prisma.applicationMessage.findFirstOrThrow()).body,
    ).toHaveLength(4000);
  });

  it.each([123, true, null, ['hello'], { text: 'hello' }])(
    'rejects non-string message bodies %j',
    async (value) => {
      await provider.agent
        .post(path('provider', '/messages'))
        .send({ body: value })
        .expect(400);
      expect(await prisma.applicationConversation.count()).toBe(0);
    },
  );

  it('enforces database uniqueness for the application conversation', async () => {
    await open();
    await expect(
      prisma.applicationConversation.create({ data: { applicationId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.applicationConversation.count()).toBe(1);
  });

  it('allows existing participants to communicate while PAUSED and disables sending while ARCHIVED', async () => {
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.PAUSED },
    });
    await open();
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Paused reply' })
      .expect(201);
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.ARCHIVED },
    });
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Archived' })
      .expect(409);
    expect(
      body(await applicant.agent.get(path('applicant')).expect(200)),
    ).toMatchObject({ isOpen: true, canCurrentUserSend: false });
  });

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])('keeps history readable and rejects sending when %s', async (status) => {
    await open();
    await prisma.application.update({
      where: { id: applicationId },
      data: { status },
    });
    for (const side of ['provider', 'applicant'] as const) {
      const agent = side === 'provider' ? provider.agent : applicant.agent;
      expect(body(await agent.get(path(side)).expect(200))).toMatchObject({
        isOpen: true,
        canCurrentUserSend: false,
        expectedResponder: null,
        messages: [{ sequence: 1 }],
      });
      await agent
        .post(path(side, '/messages'))
        .send({ body: 'Terminal' })
        .expect(409);
    }
    await applicant.agent
      .patch(path('applicant', '/read'))
      .send({ throughSequence: 1 })
      .expect(200);
  });

  it('disables sending on a rented listing while retaining readable history', async () => {
    await open();
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.RENTED },
    });
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Reply' })
      .expect(409);
    expect(
      body(await provider.agent.get(path('provider')).expect(200)),
    ).toMatchObject({ canCurrentUserSend: false, messages: [{ sequence: 1 }] });
  });

  it('resumes the same conversation and turn after restoration to ACTIVE', async () => {
    await open();
    const before = await prisma.applicationConversation.findFirstOrThrow();
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/reject`)
      .expect(200);
    await prisma.listingEvent.updateMany({
      where: { applicationId },
      data: { occurredAt: new Date(0) },
    });
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/restore`)
      .expect(200);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Wrong turn' })
      .expect(409);
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Restored reply' })
      .expect(201);
    expect((await prisma.applicationConversation.findFirstOrThrow()).id).toBe(
      before.id,
    );
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.CONVERSATION_OPENED },
      }),
    ).toBe(1);
  });

  it('denies WAITING surfaces even for a previously opened conversation', async () => {
    await open();
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING, activeAt: null },
    });
    await provider.agent.get(path('provider')).expect(404);
    await provider.agent.get(path('provider', '/summary')).expect(404);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Hidden' })
      .expect(404);
    await provider.agent
      .patch(path('provider', '/read'))
      .send({ throughSequence: 1 })
      .expect(404);
    expect(
      body(await applicant.agent.get(path('applicant')).expect(200)),
    ).toMatchObject({ canCurrentUserSend: false });
  });

  it('does not open chat for never-visible WAITING or rejected applications', async () => {
    for (const status of [
      ApplicationStatus.WAITING,
      ApplicationStatus.REJECTED,
    ]) {
      await prisma.application.update({
        where: { id: applicationId },
        data: { status, activeAt: null },
      });
      await provider.agent.get(path('provider', '/summary')).expect(404);
      await provider.agent
        .post(path('provider', '/messages'))
        .send({ body: 'Hidden' })
        .expect(404);
    }
    expect(await prisma.applicationConversation.count()).toBe(0);
  });

  it('enforces authentication, roles, ownership and cross-application isolation on every surface', async () => {
    await open();
    const otherProvider = await register('provider');
    const otherApplicant = await register('applicant');
    for (const side of ['provider', 'applicant'] as const) {
      const foreign =
        side === 'provider' ? otherProvider.agent : otherApplicant.agent;
      const wrongRole = side === 'provider' ? applicant.agent : provider.agent;
      for (const suffix of ['', '/summary']) {
        await request
          .agent(server)
          .ca(certificate)
          .get(path(side, suffix))
          .expect(401);
        await foreign.get(path(side, suffix)).expect(404);
        await wrongRole.get(path(side, suffix)).expect(403);
      }
      await foreign
        .post(path(side, '/messages'))
        .send({ body: 'Foreign' })
        .expect(404);
      await foreign
        .patch(path(side, '/read'))
        .send({ throughSequence: 1 })
        .expect(404);
      await wrongRole
        .post(path(side, '/messages'))
        .send({ body: 'Wrong role' })
        .expect(403);
      await wrongRole
        .patch(path(side, '/read'))
        .send({ throughSequence: 1 })
        .expect(403);
      await request
        .agent(server)
        .ca(certificate)
        .post(path(side, '/messages'))
        .send({ body: 'Unauthenticated' })
        .expect(401);
      await request
        .agent(server)
        .ca(certificate)
        .patch(path(side, '/read'))
        .send({ throughSequence: 1 })
        .expect(401);
    }
    expect(await prisma.applicationMessage.count()).toBe(1);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WITHDRAWN, withdrawnAt: new Date() },
    });
    const ownOther = await prisma.application.create({
      data: {
        applicantId: applicant.id,
        listingId,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    expect(
      body(
        await applicant.agent
          .get(`/api/v1/applicant/applications/${ownOther.id}/conversation`)
          .expect(200),
      ),
    ).toMatchObject({ isOpen: false, messages: [] });
    await prisma.user.update({
      where: { id: otherProvider.id },
      data: { role: Role.ADMIN },
    });
    await otherProvider.agent.get(path('provider')).expect(403);
  });

  it('rolls back opening, message and activities when message activity fails', async () => {
    const activity = app.get(ApplicationActivityService);
    const original = activity.appendWithinTransaction.bind(activity);
    jest
      .spyOn(activity, 'appendWithinTransaction')
      .mockImplementation((tx, input) => {
        if (input.type === ApplicationActivityType.MESSAGE_SENT)
          throw new Error('Injected activity failure');
        return original(tx, input);
      });
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Rollback' })
      .expect(500);
    expect(await prisma.applicationConversation.count()).toBe(0);
    expect(await prisma.applicationMessage.count()).toBe(0);
    expect(await prisma.applicationActivity.count()).toBe(0);
  });

  it('validates IDs, pagination and read input at HTTP boundaries', async () => {
    await provider.agent
      .get('/api/v1/provider/applications/not-a-uuid/conversation')
      .expect(400);
    await provider.agent
      .get(path('provider'))
      .query({ limit: 101 })
      .expect(400);
    await provider.agent
      .get(path('provider'))
      .query({ afterSequence: -1 })
      .expect(400);
    await provider.agent
      .patch(path('provider', '/read'))
      .send({ throughSequence: 0 })
      .expect(400);
  });
});
