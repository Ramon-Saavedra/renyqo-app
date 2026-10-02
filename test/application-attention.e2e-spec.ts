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
import { Client } from 'pg';
import { ApplicationAttentionQueryService } from '../src/application-attention/application-attention-query.service';
import { ApplicationConversationReadService } from '../src/application-conversation/application-conversation-read.service';
import { ApplicationPendingActionType as Action } from '../src/application-attention/application-pending-action';
import { AttentionQueryDto } from '../src/application-attention/dto/attention-input.dto';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationStatus,
  ListingStatus,
  ConversationSide,
  ApplicationDocumentType,
  ApplicationDocumentState,
  ApplicationViewingStatus as ViewingStatus,
  ViewingOutcome,
  ViewingInterest,
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

describe('Application attention E2E', () => {
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
  let queries: ApplicationAttentionQueryService;
  let conversations: ApplicationConversationReadService;

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
    queries = app.get(ApplicationAttentionQueryService);
    conversations = app.get(ApplicationConversationReadService);
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
      },
    });
    listingId = listing.id;
    applicationId = (await createApplication()).id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const url = process.env['E2E_DATABASE_URL'];
    if (
      !url ||
      process.env['DATABASE_URL'] !== url ||
      process.env['NODE_ENV'] !== 'test' ||
      process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
    )
      throw new Error('Unsafe E2E cleanup configuration');
    assertSafeE2EDatabaseUrl(url);
    if (!prisma) return;
    await prisma.$executeRaw`TRUNCATE TABLE application_viewing_interests, application_viewing_outcomes, application_viewings`;
    await prisma.applicationDocumentRequest.updateMany({
      data: { currentFileId: null },
    });
    await prisma.applicationDocumentFile.deleteMany();
    await prisma.applicationDocumentRequest.deleteMany();
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

  function createApplication(ownerId = applicant.id) {
    return prisma.application.create({
      data: {
        listingId,
        applicantId: ownerId,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      },
    });
  }

  async function attention(side: 'provider' | 'applicant', id = applicationId) {
    const response = await (side === 'provider' ? provider : applicant).agent
      .get(`/api/v1/${side}/applications/${id}/attention`)
      .expect(200);
    return body(response);
  }

  async function aggregate(side: 'provider' | 'applicant', suffix = '') {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .get(`/api/v1/${side}/attention${suffix}`)
        .expect(200),
    );
  }

  function actions(
    response: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const value = response['pendingActions'];
    if (!Array.isArray(value) || !value.every(isRecord))
      throw new Error('Expected action array');
    return value;
  }

  function items(response: Record<string, unknown>): Record<string, unknown>[] {
    const value = response['items'];
    if (!Array.isArray(value) || !value.every(isRecord))
      throw new Error('Expected items');
    return value;
  }

  async function message(
    senderType: ConversationSide = ConversationSide.PROVIDER,
    sequence = 1,
    readAt: Date | null = null,
    appId = applicationId,
  ) {
    const conversation = await prisma.applicationConversation.upsert({
      where: { applicationId: appId },
      create: { applicationId: appId },
      update: {},
    });
    return prisma.applicationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType,
        sequence,
        body: 'Private message body',
        readAt,
        createdAt: now,
      },
    });
  }

  async function document(
    state?: ApplicationDocumentState,
    round = 1,
    appId = applicationId,
    logicalKey = 'income_proof',
  ) {
    const request = await prisma.applicationDocumentRequest.create({
      data: {
        applicationId: appId,
        type: ApplicationDocumentType.INCOME_PROOF,
        logicalKey,
        round,
        requestedAt: now,
      },
    });
    if (!state) return { request, file: null };
    const file = await prisma.applicationDocumentFile.create({
      data: {
        requestId: request.id,
        storageKey: randomUUID(),
        bucket: 'attention-e2e-only',
        checksum: 'a'.repeat(64),
        mimeType: 'application/pdf',
        size: 100,
        state,
        recoverAfter: now,
        expiresAt: new Date(now.getTime() + 60000),
        availableAt: state === ApplicationDocumentState.AVAILABLE ? now : null,
      },
    });
    await prisma.applicationDocumentRequest.update({
      where: { id: request.id },
      data: { currentFileId: file.id },
    });
    return { request, file };
  }

  async function viewing(
    status: ViewingStatus = ViewingStatus.PROPOSED,
    round = 1,
    appId = applicationId,
  ) {
    return prisma.applicationViewing.create({
      data: {
        applicationId: appId,
        round,
        status,
        startsAt: new Date(now.getTime() + 60000),
        endsAt: new Date(now.getTime() + 1860000),
        timeZone: 'Europe/Berlin',
        requestKey: randomUUID(),
        requestHash: 'b'.repeat(64),
        createdAt: now,
        acceptedAt:
          status === ViewingStatus.ACCEPTED ||
          status === ViewingStatus.COMPLETED ||
          status === ViewingStatus.NO_SHOW
            ? now
            : null,
        changeRequestedAt:
          status === ViewingStatus.CHANGE_REQUESTED ? now : null,
        declinedAt: status === ViewingStatus.DECLINED ? now : null,
        cancelledAt: status === ViewingStatus.CANCELLED ? now : null,
        supersededAt: status === ViewingStatus.SUPERSEDED ? now : null,
        ...(status === ViewingStatus.COMPLETED ||
        status === ViewingStatus.NO_SHOW
          ? {
              outcomes: {
                create: {
                  revision: 1,
                  outcome:
                    status === ViewingStatus.COMPLETED
                      ? ViewingOutcome.COMPLETED
                      : ViewingOutcome.NO_SHOW,
                  recordedAt: now,
                },
              },
            }
          : {}),
      },
    });
  }

  it('keeps unopened conversations action-free without counting an optional initiation', async () => {
    for (const side of ['provider', 'applicant'] as const) {
      expect(await attention(side)).toMatchObject({
        pendingActions: [],
        pendingActionCount: 0,
        historicalUnreadMessageCount: 0,
        actionableUnreadMessageCount: 0,
        conversation: { isOpen: false, isReadOnly: false },
        asOf: now.toISOString(),
      });
    }
  });

  it('counts unread independently of reply responsibility and read acknowledgement', async () => {
    await message();
    expect(await attention('applicant')).toMatchObject({
      historicalUnreadMessageCount: 1,
      actionableUnreadMessageCount: 1,
      pendingActions: [{ type: Action.RESPOND_TO_MESSAGE }],
    });
    await applicant.agent
      .patch(
        `/api/v1/applicant/applications/${applicationId}/conversation/read`,
      )
      .send({ throughSequence: 1 })
      .expect(200);
    expect(await attention('applicant')).toMatchObject({
      historicalUnreadMessageCount: 0,
      actionableUnreadMessageCount: 0,
      pendingActions: [{ type: Action.RESPOND_TO_MESSAGE }],
    });
  });

  it('keeps unread without a reply action when the latest message is already from this audience', async () => {
    await message();
    await message(ConversationSide.APPLICANT, 2);
    expect(await attention('applicant')).toMatchObject({
      historicalUnreadMessageCount: 1,
      actionableUnreadMessageCount: 1,
      pendingActions: [],
    });
    expect(await attention('provider')).toMatchObject({
      pendingActions: [{ type: Action.RESPOND_TO_MESSAGE }],
    });
  });

  it('combines three obligations without leaking messages or sorting fields', async () => {
    await message();
    await document();
    await viewing();
    const response = await attention('applicant');
    expect(response['pendingActionCount']).toBe(3);
    expect(new Set(actions(response).map((row) => row['type']))).toEqual(
      new Set([
        Action.RESPOND_TO_MESSAGE,
        Action.UPLOAD_REQUESTED_DOCUMENT,
        Action.RESPOND_TO_VIEWING,
      ]),
    );
    const json = JSON.stringify(response);
    for (const forbidden of [
      'Private message body',
      'pendingSince',
      'storageKey',
      'checksum',
      'requestHash',
      'passwordHash',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it.each([
    undefined,
    ApplicationDocumentState.FAILED,
    ApplicationDocumentState.PROCESSING,
    ApplicationDocumentState.AVAILABLE,
  ])(
    'derives document upload/review facts from current state %s',
    async (state) => {
      const row = await document(state);
      const applicantTypes = actions(await attention('applicant')).map(
        (action) => action['type'],
      );
      const providerTypes = actions(await attention('provider')).map(
        (action) => action['type'],
      );
      expect(applicantTypes).toEqual(
        !state || state === ApplicationDocumentState.FAILED
          ? [Action.UPLOAD_REQUESTED_DOCUMENT]
          : [],
      );
      expect(providerTypes).toEqual(
        state === ApplicationDocumentState.AVAILABLE
          ? [Action.REVIEW_DOCUMENT]
          : [],
      );
      if (row.file?.state === ApplicationDocumentState.AVAILABLE) {
        await provider.agent
          .post(
            `/api/v1/provider/applications/${applicationId}/documents/${row.file.id}/review`,
          )
          .send({ status: 'REVIEWED' })
          .expect(201);
        expect(actions(await attention('provider'))).toEqual([]);
      }
    },
  );

  it('does not offer retry for a failed file that was previously available', async () => {
    const row = await document(ApplicationDocumentState.FAILED);
    if (!row.file) throw new Error('Expected file');
    await prisma.applicationDocumentFile.update({
      where: { id: row.file.id },
      data: { availableAt: now },
    });
    expect(actions(await attention('applicant'))).toEqual([]);
  });

  it('uses only replacement request rounds, excluding stale review and upload obligations', async () => {
    const old = await document(ApplicationDocumentState.AVAILABLE);
    await prisma.applicationDocumentRequest.update({
      where: { id: old.request.id },
      data: { supersededAt: now },
    });
    const current = await document(undefined, 2);
    expect(actions(await attention('provider'))).toEqual([]);
    expect(actions(await attention('applicant'))).toMatchObject([
      {
        type: Action.UPLOAD_REQUESTED_DOCUMENT,
        target: { requestId: current.request.id },
      },
    ]);
  });

  it('changes proposal responsibility exactly at startsAt and records outcome exactly at endsAt', async () => {
    const row = await viewing();
    expect(actions(await attention('applicant'))).toMatchObject([
      { type: Action.RESPOND_TO_VIEWING },
    ]);
    now = row.startsAt;
    expect(actions(await attention('applicant'))).toEqual([]);
    expect(actions(await attention('provider'))).toMatchObject([
      { type: Action.CLOSE_UNANSWERED_VIEWING },
    ]);
    await prisma.applicationViewing.update({
      where: { id: row.id },
      data: { status: ViewingStatus.ACCEPTED, acceptedAt: now },
    });
    now = new Date(row.endsAt.getTime() - 1);
    expect(actions(await attention('provider'))).toEqual([]);
    now = row.endsAt;
    expect(actions(await attention('provider'))).toMatchObject([
      { type: Action.RECORD_VIEWING_OUTCOME },
    ]);
  });

  it('derives provider responsibility for requested viewing changes', async () => {
    await viewing(ViewingStatus.CHANGE_REQUESTED);
    expect(actions(await attention('provider'))).toMatchObject([
      { type: Action.RESPOND_TO_VIEWING_CHANGE_REQUEST },
    ]);
    expect(actions(await attention('applicant'))).toEqual([]);
  });

  it('keeps all historical completed rounds awaiting interest alongside a new proposal', async () => {
    const first = await viewing(ViewingStatus.COMPLETED);
    const second = await viewing(ViewingStatus.COMPLETED, 2);
    const third = await viewing(ViewingStatus.PROPOSED, 3);
    const response = await attention('applicant');
    expect(response['pendingActionCount']).toBe(3);
    expect(
      new Set(
        actions(response).map((row) =>
          isRecord(row['target']) ? row['target']['viewingId'] : null,
        ),
      ),
    ).toEqual(new Set([first.id, second.id, third.id]));
    await applicant.agent
      .patch(
        `/api/v1/applicant/applications/${applicationId}/viewings/${first.id}/interest`,
      )
      .send({ interest: ViewingInterest.STILL_INTERESTED })
      .expect(200);
    expect((await attention('applicant'))['pendingActionCount']).toBe(2);
    await applicant.agent
      .patch(
        `/api/v1/applicant/applications/${applicationId}/viewings/${third.id}/accept`,
      )
      .send({})
      .expect(200);
    expect((await attention('applicant'))['pendingActionCount']).toBe(1);
  });

  it.each([ViewingStatus.COMPLETED, ViewingStatus.NO_SHOW])(
    'updates interest attention from effective corrected outcome %s',
    async (initialStatus) => {
      const row = await viewing(initialStatus);
      await document();
      expect(
        actions(await attention('applicant')).some(
          (action) => action['type'] === Action.CONFIRM_POST_VIEWING_INTEREST,
        ),
      ).toBe(initialStatus === ViewingStatus.COMPLETED);
      now = new Date(now.getTime() + 60000);
      const corrected =
        initialStatus === ViewingStatus.COMPLETED
          ? ViewingOutcome.NO_SHOW
          : ViewingOutcome.COMPLETED;
      await provider.agent
        .patch(
          `/api/v1/provider/applications/${applicationId}/viewings/${row.id}/correct-outcome`,
        )
        .send({ outcome: corrected, reason: 'Attendance correction' })
        .expect(200);
      const types = actions(await attention('applicant')).map(
        (action) => action['type'],
      );
      expect(types).toEqual(
        corrected === ViewingOutcome.COMPLETED
          ? [
              Action.UPLOAD_REQUESTED_DOCUMENT,
              Action.CONFIRM_POST_VIEWING_INTEREST,
            ]
          : [Action.UPLOAD_REQUESTED_DOCUMENT],
      );
      const history = await prisma.applicationViewingOutcome.findMany({
        where: { viewingId: row.id },
        orderBy: { revision: 'asc' },
      });
      expect(history.map((decision) => decision.revision)).toEqual([1, 2]);
      expect(history[1]?.recordedAt).toEqual(now);
    },
  );

  it.each([
    ViewingStatus.DECLINED,
    ViewingStatus.CANCELLED,
    ViewingStatus.NO_SHOW,
    ViewingStatus.SUPERSEDED,
  ])('creates no invalid action for resolved viewing %s', async (status) => {
    await viewing(status);
    expect(actions(await attention('provider'))).toEqual([]);
    expect(actions(await attention('applicant'))).toEqual([]);
  });

  it.each([
    ApplicationStatus.WAITING,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])(
    'suppresses actionable badges for application lifecycle %s',
    async (status) => {
      await message();
      await document();
      await viewing();
      await prisma.application.update({
        where: { id: applicationId },
        data: { status },
      });
      expect(await attention('applicant')).toMatchObject({
        pendingActions: [],
        historicalUnreadMessageCount: 1,
        actionableUnreadMessageCount: 0,
        conversation: { isReadOnly: true, expectedResponder: null },
      });
      expect((await aggregate('applicant'))['totals']).toEqual({
        applicationsWithPendingActions: 0,
        totalPendingActions: 0,
        actionableUnreadMessageCount: 0,
      });
      if (status === ApplicationStatus.WAITING) {
        await provider.agent
          .get(`/api/v1/provider/applications/${applicationId}/attention`)
          .expect(404);
        expect(items(await aggregate('provider'))).toEqual([]);
      } else {
        expect((await attention('provider'))['pendingActions']).toEqual([]);
      }
    },
  );

  it.each(Object.values(ListingStatus))(
    'enforces listing lifecycle %s for all domains',
    async (status) => {
      await message();
      await document();
      await viewing();
      await prisma.listing.update({
        where: { id: listingId },
        data: { status },
      });
      const mutable =
        status === ListingStatus.PUBLISHED || status === ListingStatus.PAUSED;
      const result = await attention('applicant');
      expect(result['pendingActionCount']).toBe(mutable ? 3 : 0);
      expect(result['actionableUnreadMessageCount']).toBe(mutable ? 1 : 0);
    },
  );

  it('excludes WAITING facts before domain loading and hides never-active exited applications', async () => {
    await message(ConversationSide.APPLICANT);
    await document(ApplicationDocumentState.AVAILABLE);
    await viewing(ViewingStatus.CHANGE_REQUESTED);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING },
    });
    const reads = jest.spyOn(conversations, 'batch');
    const response = await aggregate('provider');
    expect(items(response)).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain(applicationId);
    expect(response['totals']).toEqual({
      applicationsWithPendingActions: 0,
      totalPendingActions: 0,
      actionableUnreadMessageCount: 0,
    });
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED, activeAt: null },
    });
    await provider.agent
      .get(`/api/v1/provider/applications/${applicationId}/attention`)
      .expect(404);
  });

  for (const status of Object.values(ApplicationStatus)) {
    for (const historical of [false, true]) {
      it(`preserves shared provider visibility across all domains for ${status}, history=${historical}`, async () => {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status, activeAt: historical ? now : null },
        });
        const visible =
          status !== ApplicationStatus.WAITING &&
          (status === ApplicationStatus.ACTIVE || historical);
        for (const suffix of [
          'attention',
          'conversation/summary',
          'document-requests',
          'viewings',
        ]) {
          await provider.agent
            .get(`/api/v1/provider/applications/${applicationId}/${suffix}`)
            .expect(visible ? 200 : 404);
        }
        const response = await aggregate('provider');
        expect(items(response)).toHaveLength(visible ? 1 : 0);
      });
    }
  }

  it('isolates other providers/applicants and rejects wrong roles and malformed DTO inputs', async () => {
    const outsiderProvider = await register('provider');
    const outsiderApplicant = await register('applicant');
    await outsiderProvider.agent
      .get(`/api/v1/provider/applications/${applicationId}/attention`)
      .expect(404);
    await outsiderProvider.agent
      .get(`/api/v1/provider/listings/${listingId}/attention`)
      .expect(404);
    await outsiderApplicant.agent
      .get(`/api/v1/applicant/applications/${applicationId}/attention`)
      .expect(404);
    expect(
      items(
        body(
          await outsiderProvider.agent
            .get('/api/v1/provider/attention')
            .expect(200),
        ),
      ),
    ).toEqual([]);
    expect(
      items(
        body(
          await outsiderApplicant.agent
            .get('/api/v1/applicant/attention')
            .expect(200),
        ),
      ),
    ).toEqual([]);
    await applicant.agent.get('/api/v1/provider/attention').expect(403);
    await provider.agent.get('/api/v1/applicant/attention').expect(403);
    await request(server)
      .get('/api/v1/provider/attention')
      .ca(certificate)
      .expect(401);
    await applicant.agent
      .get('/api/v1/applicant/applications/invalid/attention')
      .expect(400);
    await applicant.agent
      .get('/api/v1/applicant/attention?limit=101')
      .expect(400);
    await applicant.agent
      .get('/api/v1/applicant/attention?offset=-1')
      .expect(400);
    await applicant.agent
      .get('/api/v1/applicant/attention?unknown=true')
      .expect(400);
  });

  it('computes exact totals across pagination and listing/application scopes', async () => {
    await message(ConversationSide.APPLICANT);
    await document(ApplicationDocumentState.AVAILABLE);
    await viewing(ViewingStatus.CHANGE_REQUESTED);
    const extra = await createApplication((await register('applicant')).id);
    await document(ApplicationDocumentState.AVAILABLE, 1, extra.id);
    const response = await aggregate('provider', '?limit=1');
    expect(response['totals']).toEqual({
      applicationsWithPendingActions: 2,
      totalPendingActions: 4,
      actionableUnreadMessageCount: 1,
    });
    expect(items(response)).toHaveLength(1);
    expect(response['pagination']).toMatchObject({
      totalApplications: 2,
      hasMore: true,
    });
    const next = await aggregate('provider', '?limit=1&offset=1');
    expect(next['totals']).toEqual(response['totals']);
    expect(items(next)[0]?.['applicationId']).not.toBe(
      items(response)[0]?.['applicationId'],
    );
    const listing = body(
      await provider.agent
        .get(`/api/v1/provider/listings/${listingId}/attention?limit=1`)
        .expect(200),
    );
    expect(listing['totals']).toEqual(response['totals']);
    const applicantResponse = await aggregate('applicant');
    expect(applicantResponse['totals']).toEqual({
      applicationsWithPendingActions: 0,
      totalPendingActions: 0,
      actionableUnreadMessageCount: 0,
    });
    expect(items(applicantResponse)).toHaveLength(1);
    const batch = await queries.batch(provider.id, 'provider', [
      applicationId,
      extra.id,
      applicationId,
    ]);
    expect(batch.items).toHaveLength(2);
    for (const item of batch.items) {
      const detail = await attention('provider', item.applicationId);
      expect(item.pendingActionCount).toBe(detail['pendingActionCount']);
      expect(item.actionableUnreadMessageCount).toBe(
        detail['actionableUnreadMessageCount'],
      );
    }
    await expect(
      queries.batch(provider.id, 'provider', [randomUUID()]),
    ).rejects.toThrow('Application not found');
  });

  it('keeps positive applicant totals exact across the 200-application batch boundary', async () => {
    await document();
    const fixtures = Array.from({ length: 200 }, (_, index) => ({
      listingId: randomUUID(),
      applicationId: randomUUID(),
      displayOrder: index + 2,
    }));
    await prisma.listing.createMany({
      data: fixtures.map((row) => ({
        id: row.listingId,
        providerId: provider.id,
        displayOrder: row.displayOrder,
        status: ListingStatus.PUBLISHED,
      })),
    });
    await prisma.application.createMany({
      data: fixtures.map((row) => ({
        id: row.applicationId,
        listingId: row.listingId,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      })),
    });
    await prisma.applicationDocumentRequest.createMany({
      data: fixtures.map((row) => ({
        applicationId: row.applicationId,
        type: ApplicationDocumentType.INCOME_PROOF,
        logicalKey: 'income_proof',
        round: 1,
        requestedAt: now,
      })),
    });
    const clock = jest.spyOn(app.get(ViewingClock), 'now');
    const response = await queries.aggregate(applicant.id, 'applicant', {
      offset: 199,
      limit: 1,
    });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(response.totals).toEqual({
      applicationsWithPendingActions: 201,
      totalPendingActions: 201,
      actionableUnreadMessageCount: 0,
    });
    expect(response.pagination).toMatchObject({
      totalApplications: 201,
      hasMore: true,
    });
    expect(response.items).toHaveLength(1);
    expect(response.listings).toHaveLength(201);
    expect(
      response.listings.every((row) => row.totalPendingActions === 1),
    ).toBe(true);
    const batch = await queries.batch(applicant.id, 'applicant', [
      applicationId,
      ...fixtures.map((row) => row.applicationId),
    ]);
    expect(batch.items).toHaveLength(201);
    expect(batch.items.every((row) => row.pendingActionCount === 1)).toBe(true);
    expect(
      batch.items.find(
        (row) => row.applicationId === response.items[0]?.applicationId,
      ),
    ).toEqual(response.items[0]);
  });

  it('keeps action ordering deterministic with equal timestamps and repeated reads', async () => {
    await document(undefined, 1, applicationId, 'a');
    await document(undefined, 1, applicationId, 'b');
    await viewing();
    await message();
    expect(await attention('applicant')).toEqual(await attention('applicant'));
    expect(
      actions(await attention('applicant')).map((row) => row['type']),
    ).toEqual([
      Action.RESPOND_TO_MESSAGE,
      Action.RESPOND_TO_VIEWING,
      Action.UPLOAD_REQUESTED_DOCUMENT,
      Action.UPLOAD_REQUESTED_DOCUMENT,
    ]);
  });

  it('uses one consistent database snapshot when a message commits between domain reads', async () => {
    await message();
    const original = conversations.batch.bind(conversations);
    jest
      .spyOn(conversations, 'batch')
      .mockImplementationOnce(async (tx, ids, side) => {
        await message(ConversationSide.APPLICANT, 2);
        return original(tx, ids, side);
      });
    expect(actions(await attention('applicant'))).toMatchObject([
      { type: Action.RESPOND_TO_MESSAGE },
    ]);
    expect(actions(await attention('applicant'))).toEqual([]);
  });

  it('bounds actual PostgreSQL queries as application counts grow without reading bodies/history', async () => {
    await message();
    await document();
    await viewing();
    const spy = jest.spyOn(Client.prototype, 'query');
    await queries.aggregate(applicant.id, 'applicant', new AttentionQueryDto());
    const statements = () =>
      spy.mock.calls
        .map((call) => {
          const input: unknown = call[0];
          return typeof input === 'string'
            ? input
            : isRecord(input) && typeof input['text'] === 'string'
              ? input['text']
              : '';
        })
        .filter((text) => /SELECT/i.test(text));
    const single = statements().length;
    expect(single).toBeGreaterThan(0);
    spy.mockClear();
    for (let index = 0; index < 24; index++) {
      const listing = await prisma.listing.create({
        data: {
          providerId: provider.id,
          displayOrder: index + 2,
          status: ListingStatus.PUBLISHED,
        },
      });
      listingId = listing.id;
      const row = await createApplication();
      await message(ConversationSide.PROVIDER, 1, null, row.id);
      await document(undefined, 1, row.id);
      await viewing(ViewingStatus.PROPOSED, 1, row.id);
    }
    spy.mockClear();
    const result = await queries.aggregate(
      applicant.id,
      'applicant',
      new AttentionQueryDto(),
    );
    const many = statements();
    expect(result.totals.totalPendingActions).toBe(75);
    expect(result.totals.applicationsWithPendingActions).toBe(25);
    expect(many.length).toBe(single);
    expect(many.length).toBeLessThanOrEqual(15);
    expect(many.join(' ')).not.toMatch(
      /"body"|application_activities|storage_key|password_hash/i,
    );
  });
});
