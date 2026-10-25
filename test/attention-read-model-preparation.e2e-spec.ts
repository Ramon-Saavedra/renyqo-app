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
import { ApplicationAttentionQueryService } from '../src/application-attention/application-attention-query.service';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationDocumentState,
  ApplicationDocumentType,
  ApplicationStatus,
  ApplicationViewingStatus as ViewingStatus,
  ConversationSide,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type Agent = ReturnType<typeof request.agent>;
type Store = InstanceType<ReturnType<typeof connectPgSimple>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function body(response: Response): Record<string, unknown> {
  if (!isRecord(response.body)) throw new Error('Expected an object response');
  return response.body;
}

function items(response: Record<string, unknown>): Record<string, unknown>[] {
  const value = response['items'];
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error('Expected items');
  return value;
}

function nested(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`Expected object ${key}`);
  return value;
}

describe('Attention read-model preparation E2E', () => {
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
  const startsAt = new Date('2027-01-01T11:00:00Z');

  async function register(role: 'applicant' | 'provider') {
    const agent = request.agent(server).ca(certificate);
    const response = await agent
      .post('/api/v1/auth/register')
      .send({
        name: `Attention ${role}`,
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
    process.env['SESSION_SECRET'] =
      'e2e-session-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ViewingClock)
      .useValue({ now: () => now })
      .compile();
    tlsDirectory = mkdtempSync(join(tmpdir(), 'renyqo-attention-read-tls-'));
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
        publishedAt: now,
        title: 'Attention listing',
      },
    });
    listingId = listing.id;
    const application = await prisma.application.create({
      data: {
        listingId,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
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
    await prisma.applicationDocumentRequest.updateMany({
      data: { currentFileId: null },
    });
    await prisma.applicationDocumentFile.deleteMany();
    await prisma.applicationDocumentRequest.deleteMany();
    await prisma.$executeRaw`TRUNCATE TABLE application_no_show_consequences, viewing_workflows, viewing_proposals, viewing_appointments, application_consideration_positions, application_viewing_interests, application_viewing_outcomes, application_viewings`;
    await prisma.application.deleteMany();
    await prisma.savedListing.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.applicantProfile.deleteMany();
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

  async function message(senderType: ConversationSide) {
    const conversation = await prisma.applicationConversation.upsert({
      where: { applicationId },
      create: { applicationId },
      update: {},
    });
    const count = await prisma.applicationMessage.count({
      where: { conversationId: conversation.id },
    });
    return prisma.applicationMessage.create({
      data: {
        conversationId: conversation.id,
        senderType,
        sequence: count + 1,
        body: 'Private message body',
        createdAt: now,
      },
    });
  }

  async function requestDocument(
    type: ApplicationDocumentType,
    customLabel: string | null,
    state?: ApplicationDocumentState,
  ) {
    const documentRequest = await prisma.applicationDocumentRequest.create({
      data: {
        applicationId,
        type,
        customLabel,
        logicalKey: randomUUID(),
        round: 1,
        requestedAt: now,
      },
    });
    if (!state) return documentRequest;
    const file = await prisma.applicationDocumentFile.create({
      data: {
        requestId: documentRequest.id,
        storageKey: randomUUID(),
        bucket: 'attention-read-model-e2e',
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
      where: { id: documentRequest.id },
      data: { currentFileId: file.id },
    });
  }

  async function proposeViewing() {
    return prisma.applicationViewing.create({
      data: {
        applicationId,
        round: 1,
        status: ViewingStatus.PROPOSED,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        timeZone: 'Europe/Berlin',
        requestKey: randomUUID(),
        requestHash: 'b'.repeat(64),
        createdAt: now,
      },
    });
  }

  it('projects category totals, targets, document state and the viewing boundary', async () => {
    await message(ConversationSide.PROVIDER);
    await message(ConversationSide.APPLICANT);
    const other = await requestDocument(
      ApplicationDocumentType.OTHER,
      'Pet agreement',
    );
    const review = await requestDocument(
      ApplicationDocumentType.LIABILITY_INSURANCE,
      null,
      ApplicationDocumentState.AVAILABLE,
    );
    const processing = await requestDocument(
      ApplicationDocumentType.IDENTITY_DOCUMENT,
      null,
      ApplicationDocumentState.PROCESSING,
    );
    const viewing = await proposeViewing();

    const applicantAttention = body(
      await applicant.agent
        .get(`/api/v1/applicant/applications/${applicationId}/attention`)
        .expect(200),
    );
    expect(applicantAttention).toMatchObject({
      pendingActionCount: 2,
      actionableUnreadMessageCount: 1,
      historicalUnreadMessageCount: 1,
      categories: {
        documentUploadCount: 1,
        documentReviewCount: 0,
        viewingActionCount: 1,
      },
      nextRevalidateAt: startsAt.toISOString(),
    });
    expect(applicantAttention['documentIndicators']).toEqual([
      {
        requestId: other.id,
        type: 'OTHER',
        customLabel: 'Pet agreement',
        status: 'UPLOAD_REQUIRED',
      },
    ]);
    expect(applicantAttention['targets']).toEqual([
      {
        applicationId,
        listingId,
        section: 'MESSAGES',
      },
      {
        applicationId,
        listingId,
        section: 'VIEWING',
        viewingId: viewing.id,
        workflowTarget: {
          applicationId,
          workflowId: null,
          proposalId: null,
          appointmentId: viewing.id,
          section: 'VIEWING',
          action: 'APPLICANT_RESPOND_TO_VIEWING',
        },
      },
      {
        applicationId,
        listingId,
        section: 'DOCUMENTS',
        requestId: other.id,
      },
    ]);
    expect(JSON.stringify(applicantAttention)).not.toContain(processing.id);
    expect(JSON.stringify(applicantAttention['targets'])).not.toMatch(
      /https?:|\/applicant\/|\/listings\//,
    );

    const providerAttention = body(
      await provider.agent
        .get(`/api/v1/provider/applications/${applicationId}/attention`)
        .expect(200),
    );
    const file = await prisma.applicationDocumentFile.findFirstOrThrow({
      where: { requestId: review.id },
    });
    expect(providerAttention).toMatchObject({
      pendingActionCount: 1,
      actionableUnreadMessageCount: 1,
      categories: {
        documentUploadCount: 0,
        documentReviewCount: 1,
        viewingActionCount: 0,
      },
      nextRevalidateAt: startsAt.toISOString(),
    });
    expect(providerAttention['documentIndicators']).toEqual([
      {
        requestId: review.id,
        documentId: file.id,
        type: 'LIABILITY_INSURANCE',
        customLabel: null,
        status: 'RECEIVED',
      },
    ]);

    const active = await provider.agent
      .get(`/api/v1/provider/listings/${listingId}/active-applications`)
      .expect(200);
    const cards: unknown = active.body;
    if (!Array.isArray(cards) || !isRecord(cards[0]))
      throw new Error('Expected active applicant card');
    expect(cards[0]['attention']).toMatchObject({
      actionableUnreadMessageCount: 1,
      categories: { documentReviewCount: 1, viewingActionCount: 0 },
      documentIndicators: [{ requestId: review.id, status: 'RECEIVED' }],
    });

    now = startsAt;
    const flipped = body(
      await provider.agent
        .get(`/api/v1/provider/applications/${applicationId}/attention`)
        .expect(200),
    );
    expect(flipped).toMatchObject({
      categories: { documentReviewCount: 1, viewingActionCount: 1 },
      nextRevalidateAt: null,
    });
  });

  it('keeps aggregate category totals independent of pagination', async () => {
    await requestDocument(ApplicationDocumentType.SCHUFA, null);
    const secondListing = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 2,
        status: ListingStatus.PUBLISHED,
        publishedAt: now,
      },
    });
    const second = await prisma.application.create({
      data: {
        listingId: secondListing.id,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      },
    });
    await prisma.applicationDocumentRequest.create({
      data: {
        applicationId: second.id,
        type: ApplicationDocumentType.INCOME_PROOF,
        logicalKey: randomUUID(),
        round: 1,
        requestedAt: now,
      },
    });
    const earlierStartsAt = new Date('2027-01-01T11:00:00.000Z');
    const laterStartsAt = new Date('2027-01-01T12:00:00.000Z');
    const lowerId = applicationId < second.id ? applicationId : second.id;
    const higherId = lowerId === applicationId ? second.id : applicationId;
    const lowerListingId =
      lowerId === applicationId ? listingId : secondListing.id;
    const higherListingId =
      higherId === applicationId ? listingId : secondListing.id;
    for (const [id, boundary] of [
      [lowerId, laterStartsAt],
      [higherId, earlierStartsAt],
    ] as const) {
      await prisma.applicationViewing.create({
        data: {
          applicationId: id,
          round: 1,
          status: ViewingStatus.PROPOSED,
          startsAt: boundary,
          endsAt: new Date(boundary.getTime() + 30 * 60_000),
          timeZone: 'Europe/Berlin',
          requestKey: randomUUID(),
          requestHash: 'b'.repeat(64),
          createdAt: now,
        },
      });
    }
    const page = body(
      await applicant.agent
        .get('/api/v1/applicant/attention?limit=1')
        .expect(200),
    );
    const full = body(
      await applicant.agent.get('/api/v1/applicant/attention').expect(200),
    );
    expect(items(page)).toHaveLength(1);
    expect(items(page)[0]?.['applicationId']).toBe(lowerId);
    expect(items(page)[0]?.['nextRevalidateAt']).toBe(
      laterStartsAt.toISOString(),
    );
    expect(page['totals']).toEqual(full['totals']);
    expect(page['totals']).toEqual({
      applicationsWithPendingActions: 2,
      totalPendingActions: 4,
      actionableUnreadMessageCount: 0,
      categories: {
        documentUploadCount: 2,
        documentReviewCount: 0,
        viewingActionCount: 2,
      },
      nextRevalidateAt: earlierStartsAt.toISOString(),
    });
    const listings = page['listings'];
    if (!Array.isArray(listings) || !listings.every(isRecord))
      throw new Error('Expected listings');
    expect(
      listings.find((row) => row['listingId'] === higherListingId)?.[
        'nextRevalidateAt'
      ],
    ).toBe(earlierStartsAt.toISOString());
    expect(
      listings.find((row) => row['listingId'] === lowerListingId)?.[
        'nextRevalidateAt'
      ],
    ).toBe(laterStartsAt.toISOString());
  });

  it('enriches the authenticated applicant listings in one batch and omits everyone else', async () => {
    await requestDocument(ApplicationDocumentType.OTHER, 'Guarantor letter');
    const second = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 2,
        status: ListingStatus.PUBLISHED,
        publishedAt: new Date(now.getTime() - 1000),
        title: 'Second listing',
      },
    });
    const secondApplication = await prisma.application.create({
      data: {
        listingId: second.id,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: now,
      },
    });
    const batch = jest.spyOn(queries, 'batch');
    const listings = body(
      await applicant.agent.get('/api/v1/listings').expect(200),
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([applicationId, secondApplication.id]),
    );
    const own = items(listings).find((item) => item['id'] === listingId);
    if (!own) throw new Error('Expected listing card');
    expect(nested(own, 'applicationAttention')).toMatchObject({
      applicationId,
      categories: { documentUploadCount: 1 },
      documentIndicators: [
        {
          type: 'OTHER',
          customLabel: 'Guarantor letter',
          status: 'UPLOAD_REQUIRED',
        },
      ],
    });
    await prisma.savedListing.create({
      data: { applicantId: applicant.id, listingId },
    });
    batch.mockClear();
    const saved = body(
      await applicant.agent.get('/api/v1/applicant/saved-listings').expect(200),
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(items(saved)[0]?.['id']).toBe(listingId);
    expect(
      nested(items(saved)[0] ?? {}, 'applicationAttention')['applicationId'],
    ).toBe(applicationId);
    const detail = body(
      await applicant.agent.get(`/api/v1/listings/${listingId}`).expect(200),
    );
    expect(nested(detail, 'applicationAttention')['applicationId']).toBe(
      applicationId,
    );

    const anonymous = body(
      await request(server).get('/api/v1/listings').ca(certificate).expect(200),
    );
    expect(
      items(anonymous).every((item) => item['applicationAttention'] === null),
    ).toBe(true);
    expect(JSON.stringify(anonymous)).not.toContain(applicationId);
    const anonymousDetail = body(
      await request(server)
        .get(`/api/v1/listings/${listingId}`)
        .ca(certificate)
        .expect(200),
    );
    expect(anonymousDetail['applicationAttention']).toBeNull();
    expect(JSON.stringify(anonymousDetail)).not.toContain(applicationId);

    const providerListings = body(
      await provider.agent.get('/api/v1/listings').expect(200),
    );
    expect(JSON.stringify(providerListings)).not.toContain(applicationId);
    const other = await register('applicant');
    const otherListings = body(
      await other.agent.get('/api/v1/listings').expect(200),
    );
    expect(JSON.stringify(otherListings)).not.toContain(applicationId);
    expect(
      items(otherListings).every(
        (item) => item['applicationAttention'] === null,
      ),
    ).toBe(true);
  });

  it('does not expose a WAITING application to the provider', async () => {
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING },
    });
    const providerAttention = body(
      await provider.agent.get('/api/v1/provider/attention').expect(200),
    );
    expect(items(providerAttention)).toEqual([]);
    expect(JSON.stringify(providerAttention)).not.toContain(applicationId);
    const active = await provider.agent
      .get(`/api/v1/provider/listings/${listingId}/active-applications`)
      .expect(200);
    expect(active.body).toEqual([]);
    const own = body(
      await applicant.agent.get(`/api/v1/listings/${listingId}`).expect(200),
    );
    expect(nested(own, 'applicationAttention')['applicationId']).toBe(
      applicationId,
    );
    expect(nested(own, 'applicationAttention')).toMatchObject({
      pendingActionCount: 0,
      actionableUnreadMessageCount: 0,
    });
  });

  it('removes actionable attention when the application is no longer mutable', async () => {
    await message(ConversationSide.PROVIDER);
    await requestDocument(ApplicationDocumentType.SCHUFA, null);
    await proposeViewing();
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED },
    });
    const attention = body(
      await applicant.agent
        .get(`/api/v1/applicant/applications/${applicationId}/attention`)
        .expect(200),
    );
    expect(attention).toMatchObject({
      pendingActionCount: 0,
      historicalUnreadMessageCount: 1,
      actionableUnreadMessageCount: 0,
      categories: {
        documentUploadCount: 0,
        documentReviewCount: 0,
        viewingActionCount: 0,
      },
      targets: [],
      documentIndicators: [],
      nextRevalidateAt: null,
    });
  });
});
