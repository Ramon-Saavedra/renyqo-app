import { randomUUID } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'node:https';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { OutboxModule } from '../src/outbox/outbox.module';
import { ConversationOutboxEventType } from '../src/outbox/conversation-events';
import { OutboxConfigService } from '../src/outbox/outbox-config.service';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import {
  OUTBOX_PUBLISHER,
  type OutboxPublisher,
} from '../src/outbox/outbox-publisher';
import { OutboxRepository } from '../src/outbox/outbox-repository';
import { OutboxRetentionService } from '../src/outbox/outbox-retention.service';
import { OutboxWriter } from '../src/outbox/outbox-writer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationStatus,
  ConversationSide,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;

function body(response: Response): Record<string, unknown> {
  const value: unknown = response.body;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected object response');
  return value as Record<string, unknown>;
}

describe('Outbox foundation E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: RequestTarget;
  let certificate: Buffer;
  let tlsDirectory: string | undefined;
  let provider: { agent: Agent; id: string };
  let applicant: { agent: Agent; id: string };
  let applicationId: string;

  function path(side: 'provider' | 'applicant', suffix = ''): string {
    return `/api/v1/${side}/applications/${applicationId}/conversation${suffix}`;
  }

  async function register(role: 'applicant' | 'provider') {
    const agent = request.agent(server).ca(certificate);
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: `Outbox ${role}`,
        email: `${randomUUID()}@e2e.renyqo.test`,
        password: 'StrongPass123',
        role,
        acceptedTerms: true,
        acceptedPrivacy: true,
        ...(role === 'provider' ? { providerType: 'private' } : {}),
      })
      .expect(201);
    const id = body(response)['id'];
    if (typeof id !== 'string') throw new Error('Expected user id');
    return { agent, id };
  }

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
      throw new Error('Dedicated E2E database and reset marker required');
    }
    assertSafeE2EDatabaseUrl(url);
    process.env['DATABASE_URL'] = url;
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_DISPATCH_ENABLED'] = 'false';
    process.env['SESSION_SECRET'] =
      'e2e-session-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';
    execSync('npx prisma migrate deploy', {
      env: process.env,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    tlsDirectory = mkdtempSync(join(tmpdir(), 'renyqo-outbox-tls-'));
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
    const store = new PgStore({
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
    await prisma.outboxEvent.deleteMany();
    provider = await register('provider');
    applicant = await register('applicant');
    const listing = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 1,
        status: ListingStatus.PUBLISHED,
        title: 'Outbox listing',
        publishedAt: new Date(),
      },
    });
    const application = await prisma.application.create({
      data: {
        listingId: listing.id,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    applicationId = application.id;
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany();
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
    if (app) {
      app.get(OutboxRetentionService).onModuleDestroy();
      await app.get(OutboxDispatcherService).onModuleDestroy();
      await app.close();
    }
    if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true });
  });

  it('persists message.created without message bodies', async () => {
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Secret body' })
      .expect(201);
    const rows = await prisma.outboxEvent.findMany({
      where: { applicationId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(ConversationOutboxEventType.MESSAGE_CREATED);
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      messageSequence: 1,
    });
    expect(payload['messageId']).toEqual(expect.any(String));
    expect(JSON.stringify(payload)).not.toContain('Secret');
    expect(JSON.stringify(payload)).not.toContain('body');
  });

  it('skips reply-permission and read events on no-op mutations', async () => {
    await provider.agent
      .patch(path('provider', '/applicant-replies'))
      .send({ applicantRepliesEnabled: false })
      .expect(200);
    await provider.agent
      .patch(path('provider', '/applicant-replies'))
      .send({ applicantRepliesEnabled: false })
      .expect(200);
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'Hello' })
      .expect(201);
    await applicant.agent
      .patch(path('applicant', '/read'))
      .send({ throughSequence: 1 })
      .expect(200);
    await applicant.agent
      .patch(path('applicant', '/read'))
      .send({ throughSequence: 1 })
      .expect(200);
    const types = (
      await prisma.outboxEvent.findMany({ where: { applicationId } })
    ).map((row) => row.type);
    expect(types).toEqual([
      ConversationOutboxEventType.MESSAGE_CREATED,
      ConversationOutboxEventType.READ_ADVANCED,
    ]);
  });

  it('records read.advanced with reader side and cutoff', async () => {
    await provider.agent
      .post(path('provider', '/messages'))
      .send({ body: 'One' })
      .expect(201);
    await provider.agent
      .patch(path('provider', '/applicant-replies'))
      .send({ applicantRepliesEnabled: true })
      .expect(200);
    await applicant.agent
      .post(path('applicant', '/messages'))
      .send({ body: 'Two' })
      .expect(201);
    await applicant.agent
      .patch(path('applicant', '/read'))
      .send({ throughSequence: 1 })
      .expect(200);
    const read = await prisma.outboxEvent.findFirst({
      where: {
        applicationId,
        type: ConversationOutboxEventType.READ_ADVANCED,
      },
    });
    expect(read?.payload).toEqual({
      readerSide: ConversationSide.APPLICANT,
      throughSequence: 1,
      markedCount: 1,
    });
  });

  it('rolls back outbox rows with failed transactions', async () => {
    const writer = app.get(OutboxWriter);
    await expect(
      prisma.$transaction(async (tx) => {
        await writer.append(tx, {
          type: ConversationOutboxEventType.MESSAGE_CREATED,
          applicationId,
          conversationId: randomUUID(),
          occurredAt: new Date(),
          payload: { messageId: randomUUID(), messageSequence: 1 },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.outboxEvent.count({ where: { applicationId } })).toBe(
      0,
    );
  });

  it('claims pending rows exclusively under concurrency', async () => {
    const writer = app.get(OutboxWriter);
    const conversationId = randomUUID();
    await prisma.$transaction(async (tx) => {
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        await writer.append(tx, {
          type: ConversationOutboxEventType.MESSAGE_CREATED,
          applicationId,
          conversationId,
          occurredAt: new Date(),
          payload: { messageId: randomUUID(), messageSequence: sequence },
        });
      }
    });
    const repository = app.get(OutboxRepository);
    const asOf = new Date();
    const [first, second] = await Promise.all([
      repository.claimBatch(
        randomUUID(),
        asOf,
        new Date(asOf.getTime() + 30_000),
        4,
      ),
      repository.claimBatch(
        randomUUID(),
        asOf,
        new Date(asOf.getTime() + 30_000),
        4,
      ),
    ]);
    const ids = [...first, ...second].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('deletes only old dispatched rows during retention', async () => {
    const old = await prisma.outboxEvent.create({
      data: {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        applicationId,
        conversationId: randomUUID(),
        occurredAt: new Date(),
        payload: { messageId: randomUUID(), messageSequence: 1 },
        dispatchedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      },
    });
    const pending = await prisma.outboxEvent.create({
      data: {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        applicationId,
        conversationId: randomUUID(),
        occurredAt: new Date(),
        payload: { messageId: randomUUID(), messageSequence: 2 },
      },
    });
    await app.get(OutboxRetentionService).run();
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await prisma.outboxEvent.findUnique({ where: { id: pending.id } }),
    ).not.toBeNull();
  });
});

describe('Outbox dispatcher publish E2E', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let repository: OutboxRepository;
  let dispatcher: OutboxDispatcherService;
  const published: string[] = [];

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url) throw new Error('E2E database required');
    process.env['DATABASE_URL'] = url;
    execSync('npx prisma migrate deploy', {
      env: process.env,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    process.env['NODE_ENV'] = 'test';
    process.env['OUTBOX_DISPATCH_ENABLED'] = 'false';
    const publisher: OutboxPublisher = {
      publish: (event) => {
        published.push(event.eventId);
        return Promise.resolve();
      },
    };
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        OutboxModule,
      ],
    })
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();
    prisma = module.get(PrismaService);
    repository = module.get(OutboxRepository);
    dispatcher = module.get(OutboxDispatcherService);
  });

  afterEach(async () => {
    published.length = 0;
    await prisma.outboxEvent.deleteMany();
  });

  afterAll(async () => {
    module.get(OutboxRetentionService).onModuleDestroy();
    await module.get(OutboxDispatcherService).onModuleDestroy();
    await module.close();
  });

  it('dispatches at-least-once and tolerates redelivery after publish', async () => {
    const row = await prisma.outboxEvent.create({
      data: {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        applicationId: randomUUID(),
        conversationId: randomUUID(),
        occurredAt: new Date(),
        payload: { messageId: randomUUID(), messageSequence: 1 },
      },
    });
    await dispatcher.dispatchOnce();
    expect(published).toEqual([row.id]);
    const dispatched = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(dispatched.dispatchedAt).not.toBeNull();

    published.length = 0;
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { dispatchedAt: null, claimToken: null, claimedUntil: null },
    });
    await dispatcher.dispatchOnce();
    expect(published).toEqual([row.id]);
  });

  it('retries after publish failure without marking dispatched', async () => {
    let shouldFail = true;
    const failingPublisher: OutboxPublisher = {
      publish: () =>
        shouldFail ? Promise.reject(new Error('temporary')) : Promise.resolve(),
    };
    const failingDispatcher = new OutboxDispatcherService(
      module.get(OutboxConfigService),
      repository,
      failingPublisher,
    );
    const row = await prisma.outboxEvent.create({
      data: {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        applicationId: randomUUID(),
        conversationId: randomUUID(),
        occurredAt: new Date(),
        payload: { messageId: randomUUID(), messageSequence: 1 },
      },
    });
    await failingDispatcher.dispatchOnce();
    const failed = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(failed.dispatchedAt).toBeNull();
    expect(failed.lastError).toContain('temporary');
    shouldFail = false;
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await failingDispatcher.dispatchOnce();
    const success = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(success.dispatchedAt).not.toBeNull();
  });
});
