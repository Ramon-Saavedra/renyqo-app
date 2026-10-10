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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Client } from 'pg';
import { ApplicantApplicationOverviewQueryService } from '../src/application-read-models/applicant-application-overview-query.service';
import { ProviderApplicationOverviewQueryService } from '../src/application-read-models/provider-application-overview-query.service';
import { ApplicationWorkspaceQueryService } from '../src/application-read-models/application-workspace-query.service';
import { ReadModelPageQueryDto } from '../src/application-read-models/dto/read-model-input.dto';
import { ApplicationHistoryQueryService } from '../src/application-read-models/application-history-query.service';
import { ApplicationConversationReadService } from '../src/application-conversation/application-conversation-read.service';
import { PROVIDER_CURATION_COOLDOWN_MS } from '../src/applications/application-lifecycle.constants';
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
  ApplicationActivityType,
  ApplicationActivityActorType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ListingEventType,
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

describe('Application read models E2E', () => {
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

  function nested(record: Record<string, unknown>, key: string) {
    const value = record[key];
    if (!isRecord(value)) throw new Error(`Expected object ${key}`);
    return value;
  }

  function rows(record: Record<string, unknown>, key = 'items') {
    const value = record[key];
    if (!Array.isArray(value) || !value.every(isRecord))
      throw new Error(`Expected array ${key}`);
    return value;
  }

  async function get(side: 'provider' | 'applicant', path: string) {
    return body(
      await (side === 'provider' ? provider : applicant).agent
        .get(`/api/v1/${side}/${path}`)
        .expect(200),
    );
  }

  async function message(
    appId = applicationId,
    sender: ConversationSide = ConversationSide.PROVIDER,
    sequence = 1,
  ) {
    const conversation = await prisma.applicationConversation.upsert({
      where: { applicationId: appId },
      create: { applicationId: appId },
      update: {},
    });
    return prisma.applicationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: sender,
        sequence,
        body: 'Private message content',
        createdAt: now,
      },
    });
  }

  async function document(
    appId = applicationId,
    state?: ApplicationDocumentState,
    key = randomUUID(),
  ) {
    const request = await prisma.applicationDocumentRequest.create({
      data: {
        applicationId: appId,
        type: ApplicationDocumentType.INCOME_PROOF,
        logicalKey: key,
        round: 1,
        requestedAt: now,
      },
    });
    if (!state) return request;
    const file = await prisma.applicationDocumentFile.create({
      data: {
        requestId: request.id,
        storageKey: randomUUID(),
        bucket: 'read-model-e2e',
        checksum: 'a'.repeat(64),
        mimeType: 'application/pdf',
        size: 100,
        state,
        recoverAfter: now,
        expiresAt: new Date(now.getTime() + 60000),
        availableAt: state === ApplicationDocumentState.AVAILABLE ? now : null,
      },
    });
    return prisma.applicationDocumentRequest.update({
      where: { id: request.id },
      data: { currentFileId: file.id },
    });
  }

  async function viewing(
    appId = applicationId,
    status: ViewingStatus = ViewingStatus.PROPOSED,
    round = 1,
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
        declinedAt: status === ViewingStatus.DECLINED ? now : null,
        changeRequestedAt:
          status === ViewingStatus.CHANGE_REQUESTED ? now : null,
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

  function activity(
    visibility: ApplicationActivityVisibility = ApplicationActivityVisibility.BOTH,
    occurredAt = now,
  ) {
    return prisma.applicationActivity.create({
      data: {
        applicationId,
        type: ApplicationActivityType.APPLICATION_SUBMITTED,
        actorType: ApplicationActivityActorType.SYSTEM,
        visibility,
        occurredAt,
        payload: {
          initialStatus: ApplicationStatus.ACTIVE,
          reason: 'private',
          actorUserId: provider.id,
          storageKey: 'private',
        },
      },
    });
  }

  it('returns compact provider listing overview', async () => {
    const waitingApplicant = await register('applicant');
    await prisma.application.create({
      data: {
        listingId,
        applicantId: waitingApplicant.id,
        status: ApplicationStatus.WAITING,
      },
    });
    await message(applicationId, ConversationSide.APPLICANT);
    const response = await get('provider', 'listings/overview');
    expect(response['totalCount']).toBe(1);
    const item = rows(response)[0];
    expect(item).toMatchObject({
      activeApplicationsCount: 1,
      waitingCount: 1,
      attention: { totalPendingActions: 1, actionableUnreadMessageCount: 1 },
    });
    expect(Object.keys(nested(item, 'listing')).sort()).toEqual([
      'city',
      'coldRent',
      'id',
      'imageUrl',
      'status',
      'title',
    ]);
  });

  it('returns max five ACTIVE applicants and recent exits in stable domain order', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WITHDRAWN, withdrawnAt: now },
    });
    for (let i = 0; i < 8; i++) {
      await prisma.application.create({
        data: {
          listingId,
          applicantId: applicant.id,
          status: ApplicationStatus.REJECTED,
          activeAt: now,
          rejectedAt: now,
        },
      });
    }
    const active = [];
    for (let i = 0; i < 5; i++) {
      const user = await prisma.user.create({
        data: {
          name: 'Active applicant',
          email: `${randomUUID()}@e2e.renyqo.test`,
          passwordHash: 'unusable-test-hash',
          acceptedTermsAt: now,
          acceptedPrivacyAt: now,
        },
      });
      active.push(await createApplication(user.id));
    }
    const response = await get(
      'provider',
      `listings/${listingId}/application-overview`,
    );
    expect(
      rows(response, 'activeApplications').map((row) => row['applicationId']),
    ).toEqual(active.map((row) => row.id).sort());
    const expected = await prisma.application.findMany({
      where: { listingId, status: ApplicationStatus.REJECTED },
      orderBy: { id: 'desc' },
      take: 5,
      select: { id: true },
    });
    const visibleExits = rows(response, 'recentExits');
    const allExits = await prisma.application.findMany({
      where: {
        listingId,
        status: {
          in: [ApplicationStatus.WITHDRAWN, ApplicationStatus.REJECTED],
        },
      },
      orderBy: { id: 'desc' },
      take: 5,
    });
    expect(visibleExits.map((row) => row['applicationId'])).toEqual(
      allExits.map((row) => row.id),
    );
    expect(expected).toHaveLength(5);
    expect(response['exitedApplicationsCount']).toBe(9);
    expect(visibleExits).toHaveLength(5);
  });

  it('orders ACTIVE applicants by activeAt and mixed exits by effective exit time before ID ties', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.WITHDRAWN,
        withdrawnAt: new Date(now.getTime() - 9000),
      },
    });
    const active: { id: string; activeAt: Date }[] = [];
    for (const seconds of [3, 1, 2, 1, 4, 5, 6]) {
      const user = await prisma.user.create({
        data: {
          name: 'Ordered applicant',
          email: `${randomUUID()}@e2e.renyqo.test`,
          passwordHash: 'unusable-test-hash',
          acceptedTermsAt: now,
          acceptedPrivacyAt: now,
        },
      });
      const activeAt = new Date(now.getTime() + seconds * 1000);
      const row = await prisma.application.create({
        data: {
          listingId,
          applicantId: user.id,
          status: ApplicationStatus.ACTIVE,
          activeAt,
        },
      });
      active.push({ id: row.id, activeAt });
    }
    const exits: { id: string; at: Date }[] = [];
    for (const seconds of [4, 6, 2, 6, 1, 5, 3]) {
      const at = new Date(now.getTime() + seconds * 1000);
      const row = await prisma.application.create({
        data: {
          listingId,
          applicantId: applicant.id,
          status:
            seconds % 2
              ? ApplicationStatus.WITHDRAWN
              : ApplicationStatus.REJECTED,
          activeAt: now,
          ...(seconds % 2 ? { withdrawnAt: at } : { rejectedAt: at }),
        },
      });
      exits.push({ id: row.id, at });
    }
    const response = await get(
      'provider',
      `listings/${listingId}/application-overview`,
    );
    active.sort(
      (a, b) =>
        a.activeAt.getTime() - b.activeAt.getTime() || a.id.localeCompare(b.id),
    );
    exits.sort(
      (a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id),
    );
    expect(
      rows(response, 'activeApplications').map((row) => row['applicationId']),
    ).toEqual(active.slice(0, 5).map((row) => row.id));
    expect(
      rows(response, 'recentExits').map((row) => row['applicationId']),
    ).toEqual(exits.slice(0, 5).map((row) => row.id));
    expect(response['activeApplicationsCount']).toBe(7);
    expect(response['exitedApplicationsCount']).toBe(8);
  });

  it('composes applicant cards with attention, documents, conversation and viewing without content', async () => {
    await message();
    await document();
    await viewing();
    const response = await get('applicant', 'applications/overview');
    const item = rows(response)[0];
    expect(item).toMatchObject({
      applicationId,
      attention: { pendingActionCount: 3, actionableUnreadMessageCount: 1 },
      conversation: { isOpen: true, expectedResponder: 'APPLICANT' },
      documents: { uploadRequiredCount: 1 },
      viewing: { nextAction: 'APPLICANT_RESPOND_TO_VIEWING' },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /Private message|passwordHash|storageKey|actorUserId|requestHash|queueOrder/,
    );
  });

  it('selects only the authoritative cover image for applicant cards', async () => {
    await prisma.listingImage.createMany({
      data: Array.from({ length: 15 }, (_, i) => ({
        listingId,
        publicId: randomUUID(),
        secureUrl: `https://images.example/${i}`,
        position: i,
        isCover: i === 10,
      })),
    });
    expect(
      nested(
        rows(await get('applicant', 'applications/overview'))[0],
        'listing',
      )['imageUrl'],
    ).toBe('https://images.example/10');
  });

  it.each(['provider', 'applicant'] as const)(
    'returns a safe bounded %s workspace and one asOf',
    async (side) => {
      await message();
      await document(applicationId, ApplicationDocumentState.AVAILABLE);
      await viewing();
      for (let i = 0; i < 12; i++) await activity();
      const response = await get(
        side,
        `applications/${applicationId}/workspace`,
      );
      expect(rows(nested(response, 'activityPreview'))).toHaveLength(5);
      expect(nested(response, 'activityPreview')['hasMore']).toBe(true);
      expect(nested(response, 'attention')['asOf']).toBe(response['asOf']);
      expect(response).toHaveProperty(
        side === 'provider' ? 'applicant' : 'listing',
      );
      expect(response).not.toHaveProperty(
        side === 'provider' ? 'listing' : 'applicant',
      );
      expect(JSON.stringify(response)).not.toMatch(
        /Private message|actorUserId|storageKey|bucket|checksum|scanVerdict|requestHash|queueOrder|"reason"/,
      );
      expect(nested(response, 'capabilities')).toMatchObject(
        side === 'provider'
          ? { canReject: true, canSelectForRental: true, canWithdraw: false }
          : { canWithdraw: true, canReject: false },
      );
    },
  );

  it('reuses full attention and viewing next actions rather than reconstructing them', async () => {
    await message();
    await document();
    await viewing();
    const workspace = await get(
      'applicant',
      `applications/${applicationId}/workspace`,
    );
    const attention = await get(
      'applicant',
      `applications/${applicationId}/attention`,
    );
    expect(nested(workspace, 'attention')).toEqual(attention);
    const viewings = await get(
      'applicant',
      `applications/${applicationId}/viewings`,
    );
    expect(nested(workspace, 'viewingSummary')['nextAction']).toBe(
      viewings['nextAction'],
    );
  });

  it('exposes effective corrected outcomes and submitted interest without history', async () => {
    const row = await viewing(applicationId, ViewingStatus.NO_SHOW);
    await prisma.$transaction(async (tx) => {
      await tx.applicationViewingOutcome.create({
        data: {
          viewingId: row.id,
          revision: 2,
          outcome: ViewingOutcome.COMPLETED,
          correctionReason: 'Corrected',
          recordedAt: now,
        },
      });
      await tx.applicationViewing.update({
        where: { id: row.id },
        data: { status: ViewingStatus.COMPLETED },
      });
    });
    let summary = nested(
      await get('applicant', `applications/${applicationId}/workspace`),
      'viewingSummary',
    );
    expect(nested(summary, 'latest')).toMatchObject({
      effectiveOutcome: 'COMPLETED',
      capabilities: { canSubmitInterest: true, canCorrectOutcome: false },
    });
    await prisma.applicationViewingInterest.create({
      data: { viewingId: row.id, interest: ViewingInterest.STILL_INTERESTED },
    });
    summary = nested(
      await get('applicant', `applications/${applicationId}/workspace`),
      'viewingSummary',
    );
    expect(
      nested(nested(summary, 'latest'), 'postViewingInterest')['interest'],
    ).toBe('STILL_INTERESTED');
    expect(summary['pendingInterest']).toBeNull();
  });

  it.each([
    ApplicationStatus.WAITING,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
  ])(
    'hides provider identity and domains for never-active %s',
    async (status) => {
      await message();
      await document();
      await viewing();
      await activity();
      await prisma.application.update({
        where: { id: applicationId },
        data: { status, activeAt: null },
      });
      for (const suffix of [
        'workspace',
        'activity',
        'document-history',
        'attention',
        'conversation/summary',
        'document-requests',
        'viewings',
      ]) {
        await provider.agent
          .get(`/api/v1/provider/applications/${applicationId}/${suffix}`)
          .expect(404);
      }
      expect(rows(await get('provider', 'listings/overview'))[0]).toMatchObject(
        {
          activeApplicationsCount: 0,
          waitingCount: status === ApplicationStatus.WAITING ? 1 : 0,
          attention: {
            totalPendingActions: 0,
            actionableUnreadMessageCount: 0,
          },
        },
      );
      const legacy = await provider.agent
        .get('/api/v1/provider/applications')
        .expect(200);
      expect(legacy.body).toEqual([]);
      expect(
        (
          await provider.agent
            .get(`/api/v1/provider/listings/${listingId}/applications`)
            .expect(200)
        ).body,
      ).toEqual([]);
      const own = await get(
        'applicant',
        `applications/${applicationId}/workspace`,
      );
      expect(nested(own, 'attention')['pendingActionCount']).toBe(0);
    },
  );

  it.each(['provider', 'applicant'] as const)(
    'isolates foreign %s application and history reads',
    async (side) => {
      const other = await register(side);
      for (const suffix of ['workspace', 'activity', 'document-history'])
        await other.agent
          .get(`/api/v1/${side}/applications/${applicationId}/${suffix}`)
          .expect(404);
      if (side === 'provider')
        await other.agent
          .get(`/api/v1/provider/listings/${listingId}/application-overview`)
          .expect(404);
      const response = body(
        await other.agent
          .get(
            `/api/v1/${side}/${side === 'provider' ? 'listings' : 'applications'}/overview`,
          )
          .expect(200),
      );
      expect(rows(response)).toEqual([]);
    },
  );

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])(
    'retains safe historical reads and disables workflow actions for %s',
    async (status) => {
      await message();
      await document();
      await viewing();
      await prisma.application.update({
        where: { id: applicationId },
        data: { status },
      });
      for (const side of ['provider', 'applicant'] as const) {
        const response = await get(
          side,
          `applications/${applicationId}/workspace`,
        );
        expect(nested(response, 'attention')).toMatchObject({
          pendingActionCount: 0,
          actionableUnreadMessageCount: 0,
          historicalUnreadMessageCount: side === 'applicant' ? 1 : 0,
        });
        expect(nested(response, 'conversationSummary')['isReadOnly']).toBe(
          true,
        );
        expect(nested(response, 'viewingSummary')['nextAction']).toBe('NONE');
        expect(
          rows(nested(response, 'documentsSummary'), 'currentRequests')[0],
        ).toMatchObject({ canUpload: false, canReview: false });
        expect(nested(response, 'capabilities')).toMatchObject({
          canWithdraw: false,
          canReject: false,
          canSelectForRental: false,
        });
      }
    },
  );

  it('paginates applicant cards with equal timestamps without duplicates and with full totals', async () => {
    const ids = [applicationId];
    await prisma.application.update({
      where: { id: applicationId },
      data: { createdAt: now },
    });
    for (let i = 0; i < 6; i++)
      ids.push(
        (
          await prisma.application.create({
            data: {
              listingId,
              applicantId: applicant.id,
              status: ApplicationStatus.WITHDRAWN,
              activeAt: now,
              createdAt: now,
            },
          })
        ).id,
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(
        'applicant',
        `applications/overview?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response['totalCount']).toBe(7);
      seen.push(
        ...rows(response).map((row) => getString(row, 'applicationId')),
      );
      const value = nested(response, 'pagination')['nextCursor'];
      cursor = typeof value === 'string' ? value : null;
    } while (cursor);
    expect(seen).toEqual(ids.sort().reverse());
  });

  it('paginates provider listings and keeps per-listing counts independent of previews', async () => {
    const second = await prisma.listing.create({
      data: { providerId: provider.id, displayOrder: 2 },
    });
    const first = await get('provider', 'listings/overview?limit=1');
    expect(first['totalCount']).toBe(2);
    expect(nested(rows(first)[0], 'listing')['id']).toBe(listingId);
    const next = getString(nested(first, 'pagination'), 'nextCursor');
    const secondPage = await get(
      'provider',
      `listings/overview?limit=1&cursor=${next}`,
    );
    expect(nested(rows(secondPage)[0], 'listing')['id']).toBe(second.id);
    expect(secondPage['totalCount']).toBe(2);
  });

  it.each(['provider', 'applicant'] as const)(
    'paginates %s activity and filters internal/audience-only payloads',
    async (side) => {
      for (let i = 0; i < 8; i++) await activity();
      await activity(ApplicationActivityVisibility.INTERNAL);
      await activity(
        side === 'provider'
          ? ApplicationActivityVisibility.APPLICANT
          : ApplicationActivityVisibility.PROVIDER,
      );
      const first = await get(
        side,
        `applications/${applicationId}/activity?limit=3`,
      );
      expect(first['totalCount']).toBe(8);
      expect(rows(first)).toHaveLength(3);
      const cursor = getString(nested(first, 'pagination'), 'nextCursor');
      const second = await get(
        side,
        `applications/${applicationId}/activity?limit=3&cursor=${cursor}`,
      );
      expect(
        new Set([...rows(first), ...rows(second)].map((row) => row['id'])).size,
      ).toBe(6);
      expect(JSON.stringify(first)).not.toMatch(
        /actorUserId|storageKey|reason|visibility/,
      );
    },
  );

  it('paginates document request history while compact state excludes superseded requests', async () => {
    for (let i = 0; i < 8; i++) {
      const row = await document();
      await prisma.applicationDocumentRequest.update({
        where: { id: row.id },
        data: { supersededAt: now },
      });
    }
    const current = await document(
      applicationId,
      ApplicationDocumentState.PROCESSING,
    );
    const workspace = await get(
      'applicant',
      `applications/${applicationId}/workspace`,
    );
    expect(
      rows(nested(workspace, 'documentsSummary'), 'currentRequests'),
    ).toHaveLength(1);
    expect(
      nested(nested(workspace, 'documentsSummary'), 'counts')[
        'processingCount'
      ],
    ).toBe(1);
    const first = await get(
      'applicant',
      `applications/${applicationId}/document-history?limit=3`,
    );
    expect(first['totalCount']).toBe(9);
    expect(rows(first)).toHaveLength(3);
    const cursor = getString(nested(first, 'pagination'), 'nextCursor');
    expect(
      (
        await get(
          'applicant',
          `applications/${applicationId}/document-history?limit=3&cursor=${cursor}`,
        )
      )['totalCount'],
    ).toBe(9);
    expect(
      (
        await get(
          'applicant',
          `applications/${applicationId}/document-requests/${current.id}/files`,
        )
      )['totalCount'],
    ).toBe(1);
  });

  it('paginates file attempts without storage metadata and rejects a foreign request', async () => {
    const row = await document();
    for (let i = 0; i < 5; i++)
      await prisma.applicationDocumentFile.create({
        data: {
          requestId: row.id,
          storageKey: randomUUID(),
          bucket: 'private',
          checksum: 'a'.repeat(64),
          mimeType: 'application/pdf',
          size: 100,
          state: ApplicationDocumentState.FAILED,
          recoverAfter: now,
          expiresAt: now,
        },
      });
    const response = await get(
      'provider',
      `applications/${applicationId}/document-requests/${row.id}/files?limit=2`,
    );
    expect(response['totalCount']).toBe(5);
    expect(rows(response)).toHaveLength(2);
    expect(JSON.stringify(response)).not.toMatch(
      /storageKey|bucket|checksum|scanVerdict|failureReason/,
    );
    await provider.agent
      .get(
        `/api/v1/provider/applications/${applicationId}/document-requests/${randomUUID()}/files`,
      )
      .expect(404);
  });

  it.each(['limit=0', 'limit=101', 'cursor=invalid', 'unexpected=true'])(
    'rejects malformed pagination %s',
    async (query) => {
      await applicant.agent
        .get(`/api/v1/applicant/applications/overview?${query}`)
        .expect(400);
      await provider.agent
        .get(`/api/v1/provider/listings/overview?${query}`)
        .expect(400);
    },
  );

  it('retains legacy route contracts apart from the visibility correction', async () => {
    const providerList = await provider.agent
      .get('/api/v1/provider/applications')
      .expect(200);
    expect(Array.isArray(providerList.body)).toBe(true);
    const value: unknown = providerList.body;
    if (!Array.isArray(value) || !isRecord(value[0]))
      throw new Error('Expected legacy application');
    expect(Object.keys(value[0]).sort()).toEqual([
      'applicantId',
      'createdAt',
      'id',
      'listingId',
      'publicReason',
      'rejectedAt',
      'status',
      'updatedAt',
    ]);
    expect(
      Array.isArray(
        (
          await applicant.agent
            .get('/api/v1/applicant/applications')
            .expect(200)
        ).body,
      ),
    ).toBe(true);
    expect(
      Array.isArray(
        (await provider.agent.get('/api/v1/provider/listings').expect(200))
          .body,
      ),
    ).toBe(true);
    expect(
      (await get('provider', `listings/${listingId}/waiting-count`))[
        'waitingCount'
      ],
    ).toBe(0);
  });

  it('uses one clock and no nested independent attention transaction for workspace', async () => {
    await message();
    await document();
    await viewing();
    const clock = jest.spyOn(app.get(ViewingClock), 'now');
    const transaction = jest.spyOn(prisma, '$transaction');
    const sql = jest.spyOn(Client.prototype, 'query');
    const result = await app
      .get(ApplicationWorkspaceQueryService)
      .workspace(applicationId, applicant.id, 'applicant');
    expect(clock).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.attention.asOf).toEqual(result.asOf);
    const statements = sql.mock.calls.map((call) => {
      const input: unknown = call[0];
      return typeof input === 'string'
        ? input
        : isRecord(input) && typeof input['text'] === 'string'
          ? input['text']
          : '';
    });
    expect(
      statements.filter((text) =>
        text.includes('FROM "public"."applications"'),
      ),
    ).toHaveLength(2);
    expect(
      statements.filter((text) =>
        text.includes('FROM "public"."applicant_profiles"'),
      ),
    ).toHaveLength(1);
    expect(result.capabilities.admission).toMatchObject({
      currentApplicationId: applicationId,
      currentApplicationStatus: ApplicationStatus.ACTIVE,
      canSubmitApplication: false,
      submissionBlockReason: 'CURRENT_APPLICATION_EXISTS',
    });
  });

  it.each([
    ListingStatus.PAUSED,
    ListingStatus.DRAFT,
    ListingStatus.ARCHIVED,
    ListingStatus.RENTED,
  ])(
    'agrees with existing mutation policies for an ACTIVE application on %s listing',
    async (status) => {
      await prisma.listing.update({
        where: { id: listingId },
        data: { status },
      });
      const providerWorkspace = await get(
        'provider',
        `applications/${applicationId}/workspace`,
      );
      expect(nested(providerWorkspace, 'capabilities')).toMatchObject({
        canReject: true,
        canSelectForRental: status === ListingStatus.PAUSED,
      });
      const applicantWorkspace = await get(
        'applicant',
        `applications/${applicationId}/workspace`,
      );
      expect(nested(applicantWorkspace, 'capabilities')['canWithdraw']).toBe(
        true,
      );
      expect(
        nested(applicantWorkspace, 'conversationSummary')['isReadOnly'],
      ).toBe(status !== ListingStatus.PAUSED);
      await provider.agent
        .patch(`/api/v1/provider/applications/${applicationId}/reject`)
        .expect(200);
    },
  );

  it.each([
    ApplicationRejectionReason.NOT_SELECTED,
    ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
  ])('agrees with restore mutation for rejection reason %s', async (reason) => {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.REJECTED,
        rejectedAt: now,
        publicReason: reason,
      },
    });
    const response = await get(
      'provider',
      `applications/${applicationId}/workspace`,
    );
    expect(nested(response, 'capabilities')['canRestore']).toBe(
      reason === ApplicationRejectionReason.NOT_SELECTED,
    );
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/restore`)
      .expect(reason === ApplicationRejectionReason.NOT_SELECTED ? 200 : 409);
  });

  it('disables restore when authoritative eligibility fails and the mutation rejects it', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.REJECTED,
        rejectedAt: now,
        publicReason: ApplicationRejectionReason.NOT_SELECTED,
      },
    });
    await prisma.listing.update({
      where: { id: listingId },
      data: { minimumHouseholdNetIncome: 1000 },
    });
    expect(
      nested(
        await get('provider', `applications/${applicationId}/workspace`),
        'capabilities',
      )['canRestore'],
    ).toBe(false);
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/restore`)
      .expect(422);
  });

  it('agrees with restore mutation cooldown and enables restore at its exact boundary', async () => {
    now = new Date();
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/reject`)
      .expect(200);
    now = new Date();
    expect(
      nested(
        await get('provider', `applications/${applicationId}/workspace`),
        'capabilities',
      )['canRestore'],
    ).toBe(false);
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/restore`)
      .expect(429);
    const cooldown = PROVIDER_CURATION_COOLDOWN_MS;
    const event = await prisma.listingEvent.findFirstOrThrow({
      where: { applicationId, type: ListingEventType.REJECTED_BY_PROVIDER },
    });
    now = new Date();
    await prisma.listingEvent.update({
      where: { id: event.id },
      data: { occurredAt: new Date(now.getTime() - cooldown) },
    });
    expect(
      nested(
        await get('provider', `applications/${applicationId}/workspace`),
        'capabilities',
      )['canRestore'],
    ).toBe(true);
    await provider.agent
      .patch(`/api/v1/provider/applications/${applicationId}/restore`)
      .expect(200);
  });

  it.each([ListingStatus.PAUSED, ListingStatus.DRAFT, ListingStatus.RENTED])(
    'does not advertise restoration on %s listing',
    async (status) => {
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.REJECTED,
          rejectedAt: now,
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
        },
      });
      await prisma.listing.update({
        where: { id: listingId },
        data: { status },
      });
      expect(
        nested(
          await get('provider', `applications/${applicationId}/workspace`),
          'capabilities',
        )['canRestore'],
      ).toBe(false);
      await provider.agent
        .patch(`/api/v1/provider/applications/${applicationId}/restore`)
        .expect(409);
    },
  );

  it('requires authentication and the correct audience role for optimized reads', async () => {
    await request(server)
      .get('/api/v1/provider/listings/overview')
      .ca(certificate)
      .expect(401);
    await applicant.agent.get('/api/v1/provider/listings/overview').expect(403);
    await provider.agent
      .get('/api/v1/applicant/applications/overview')
      .expect(403);
  });

  it('preserves the captured snapshot when another transaction changes lifecycle and documents', async () => {
    await message();
    const conversations = app.get(ApplicationConversationReadService);
    const original = conversations.batch.bind(conversations);
    jest
      .spyOn(conversations, 'batch')
      .mockImplementationOnce(async (tx, ids, side) => {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.WITHDRAWN, withdrawnAt: now },
        });
        await document();
        return original(tx, ids, side);
      });
    const workspace = await app
      .get(ApplicationWorkspaceQueryService)
      .workspace(applicationId, applicant.id, 'applicant');
    expect(workspace.application.status).toBe(ApplicationStatus.ACTIVE);
    expect(workspace.attention.pendingActionCount).toBe(1);
    expect(workspace.documentsSummary.currentRequests).toHaveLength(0);
    const subsequent = await get(
      'applicant',
      `applications/${applicationId}/workspace`,
    );
    expect(nested(subsequent, 'application')['status']).toBe(
      ApplicationStatus.WITHDRAWN,
    );
    expect(nested(subsequent, 'attention')['pendingActionCount']).toBe(0);
  });

  it('bounds selected-listing, workspace and history queries and their database LIMITs as histories grow', async () => {
    await message();
    const request = await document();
    await viewing();
    await activity();
    const workspaces = app.get(ApplicationWorkspaceQueryService);
    const providerQuery = app.get(ProviderApplicationOverviewQueryService);
    const history = app.get(ApplicationHistoryQueryService);
    const page = new ReadModelPageQueryDto();
    page.limit = 3;
    const runs = [
      () => providerQuery.listing(provider.id, listingId),
      () => workspaces.workspace(applicationId, provider.id, 'provider'),
      () => workspaces.workspace(applicationId, applicant.id, 'applicant'),
      () => history.activity(applicant.id, 'applicant', applicationId, page),
      () => history.documents(applicant.id, 'applicant', applicationId, page),
      () =>
        history.files(
          applicant.id,
          'applicant',
          applicationId,
          request.id,
          page,
        ),
    ];
    const counts: number[][] = [];
    for (const volume of [1, 30]) {
      if (volume > 1) {
        for (let i = 0; i < 30; i++) {
          await activity();
          await message(applicationId, ConversationSide.PROVIDER, i + 2);
          await prisma.applicationDocumentFile.create({
            data: {
              requestId: request.id,
              storageKey: randomUUID(),
              bucket: 'private',
              checksum: 'a'.repeat(64),
              mimeType: 'application/pdf',
              size: 100,
              state: ApplicationDocumentState.FAILED,
              recoverAfter: now,
              expiresAt: now,
            },
          });
        }
      }
      const current: number[] = [];
      for (const run of runs) {
        const spy = jest.spyOn(Client.prototype, 'query');
        await run();
        const statements = spy.mock.calls
          .map((call) => {
            const input: unknown = call[0];
            return typeof input === 'string'
              ? input
              : isRecord(input) && typeof input['text'] === 'string'
                ? input['text']
                : '';
          })
          .filter((text) => /SELECT/i.test(text));
        current.push(statements.length);
        expect(statements.length).toBeGreaterThan(0);
        expect(statements.length).toBeLessThanOrEqual(22);
        expect(statements.join(' ')).not.toMatch(
          /"body"|storage_key|password_hash|checksum|scan_verdict/,
        );
        for (const text of statements.filter(
          (text) =>
            /application_activities|application_document_files/.test(text) &&
            !/COUNT|GROUP BY/.test(text),
        ))
          expect(text).toMatch(/LIMIT|application_document_files"\."id" IN/i);
        spy.mockRestore();
      }
      counts.push(current);
    }
    expect(counts[1]).toEqual(counts[0]);
    console.log('READ_MODEL_WORKSPACE_HISTORY_QUERIES', JSON.stringify(counts));
  }, 60000);

  it('bounds actual PostgreSQL queries for 1, 25 and 101 applications and never loads heavy projections', async () => {
    const applicantQuery = app.get(ApplicantApplicationOverviewQueryService);
    const providerQuery = app.get(ProviderApplicationOverviewQueryService);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WITHDRAWN },
    });
    const applicationIds = [applicationId];
    const results: {
      count: number;
      applicantQueries: number;
      providerQueries: number;
    }[] = [];
    for (const count of [1, 25, 101]) {
      while (applicationIds.length < count)
        applicationIds.push(
          (
            await prisma.application.create({
              data: {
                listingId,
                applicantId: applicant.id,
                status: ApplicationStatus.WITHDRAWN,
                activeAt: now,
              },
            })
          ).id,
        );
      for (const id of applicationIds.slice(
        count === 1 ? 0 : count === 25 ? 1 : 25,
      )) {
        await message(id);
        await document(id);
        await viewing(id);
      }
      const spy = jest.spyOn(Client.prototype, 'query');
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
      const query = new ReadModelPageQueryDto();
      query.limit = 100;
      const cards = await applicantQuery.overview(applicant.id, query);
      const applicantStatements = statements();
      spy.mockClear();
      const listings = await providerQuery.overview(provider.id, query);
      const providerStatements = statements();
      results.push({
        count,
        applicantQueries: applicantStatements.length,
        providerQueries: providerStatements.length,
      });
      expect(cards.totalCount).toBe(count);
      expect(cards.items.length).toBe(Math.min(count, 100));
      expect(listings.items[0].exitedApplicationsCount).toBe(count);
      expect(
        [...applicantStatements, ...providerStatements].join(' '),
      ).not.toMatch(/"body"|storage_key|password_hash|application_activities/);
      expect(applicantStatements.length).toBeGreaterThan(0);
      expect(applicantStatements.length).toBeLessThanOrEqual(18);
      expect(providerStatements.length).toBeLessThanOrEqual(18);
      spy.mockRestore();
    }
    expect(new Set(results.map((row) => row.applicantQueries)).size).toBe(1);
    expect(new Set(results.map((row) => row.providerQueries)).size).toBe(1);
    console.log('READ_MODEL_QUERY_COUNTS', JSON.stringify(results));
  }, 60000);

  it('keeps compact payload sizes independent of message, file and activity history volume', async () => {
    await message();
    const request = await document();
    await viewing();
    const before = await get('applicant', 'applications/overview');
    for (let i = 0; i < 25; i++) {
      await message(applicationId, ConversationSide.PROVIDER, i + 2);
      await activity();
      await prisma.applicationDocumentFile.create({
        data: {
          requestId: request.id,
          storageKey: randomUUID(),
          bucket: 'private',
          checksum: 'a'.repeat(64),
          mimeType: 'application/pdf',
          size: 100,
          state: ApplicationDocumentState.FAILED,
          recoverAfter: now,
          expiresAt: now,
        },
      });
    }
    const after = await get('applicant', 'applications/overview');
    expect(JSON.stringify(rows(after)).length).toBe(
      JSON.stringify(rows(before)).length + 1,
    );
    const workspace = await get(
      'applicant',
      `applications/${applicationId}/workspace`,
    );
    expect(rows(nested(workspace, 'activityPreview'))).toHaveLength(5);
    expect(
      rows(nested(workspace, 'documentsSummary'), 'currentRequests'),
    ).toHaveLength(1);
  });

  it('inspects representative PostgreSQL query plans using existing indexes', async () => {
    await prisma.listing.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        providerId: provider.id,
        displayOrder: i + 2,
      })),
    });
    await prisma.application.createMany({
      data: Array.from({ length: 1000 }, () => ({
        listingId,
        applicantId: applicant.id,
        status: ApplicationStatus.WITHDRAWN,
        activeAt: now,
      })),
    });
    await prisma.applicationActivity.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        applicationId,
        type: ApplicationActivityType.APPLICATION_SUBMITTED,
        actorType: ApplicationActivityActorType.SYSTEM,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: new Date(now.getTime() + i * 1000),
      })),
    });
    await prisma.$executeRaw`ANALYZE listings, applications, application_activities`;
    const plans = await prisma.$queryRaw<
      { 'QUERY PLAN': string }[]
    >`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM listings WHERE provider_id = ${provider.id}::uuid ORDER BY display_order ASC,id ASC LIMIT 21`;
    const activities = await prisma.$queryRaw<
      { 'QUERY PLAN': string }[]
    >`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM application_activities WHERE application_id = ${applicationId}::uuid AND visibility IN ('both','applicant') ORDER BY occurred_at DESC,id DESC LIMIT 6`;
    const applications = await prisma.$queryRaw<
      { 'QUERY PLAN': string }[]
    >`EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM applications WHERE applicant_id = ${applicant.id}::uuid ORDER BY created_at DESC,id DESC LIMIT 101`;
    expect(plans.length).toBeGreaterThan(0);
    expect(activities.length).toBeGreaterThan(0);
    console.log(
      'READ_MODEL_QUERY_PLANS',
      JSON.stringify({
        listing: plans.map((row) => row['QUERY PLAN']),
        activity: activities.map((row) => row['QUERY PLAN']),
        applications: applications.map((row) => row['QUERY PLAN']),
      }),
    );
  });
});
