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
import { ApplicationDocumentActivityService } from '../src/application-documents/application-document-activity.service';
import { ApplicationDocumentStorageService } from '../src/application-documents/application-document-storage.service';
import { ApplicationDocumentFinalizationService } from '../src/application-documents/application-document-finalization.service';
import { ApplicationDocumentService } from '../src/application-documents/application-document.service';
import { ApplicationDocumentRequestService } from '../src/application-documents/application-document-request.service';
import { DocumentRecoveryService } from '../src/application-documents/worker/document-recovery.service';
import {
  ApplicationDocumentState,
  ApplicationDocumentType,
} from '../src/generated/prisma/enums';
import { StreamableFile } from '@nestjs/common';
import type { ApplicationDocumentFile } from '../src/generated/prisma/client';
import type { DocumentScanVerdict } from '../src/application-documents/application-document-finalization.service';
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

describe('Application documents E2E', () => {
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

  function path(
    side: 'provider' | 'applicant',
    suffix = '/document-requests',
  ): string {
    return `/api/v1/${side}/applications/${applicationId}${suffix}`;
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
    process.env['DOCUMENTS_S3_BUCKET'] = 'renyqo-documents-e2e';
    process.env['DOCUMENTS_AWS_ACCOUNT_ID'] = '111122223333';
    process.env['DOCUMENTS_GUARDDUTY_PLAN_ARN'] =
      'arn:aws:guardduty:eu-central-1:111122223333:malware-protection-plan/e2e';
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

  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF',
  );

  async function createRequest(
    type: ApplicationDocumentType = ApplicationDocumentType.SCHUFA,
  ) {
    const result = await provider.agent
      .post(path('provider'))
      .send({ requests: [{ type }] })
      .expect(201);
    const data: unknown = result.body;
    if (!Array.isArray(data) || !isRecord(data[0]))
      throw new Error('Expected request list');
    return getString(data[0], 'id');
  }

  async function upload(requestId: string) {
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'put')
      .mockImplementation((file) =>
        Promise.resolve({ versionId: `version-${file.id}`, etag: 'e2e-etag' }),
      );
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'evidence')
      .mockResolvedValue('CLEAN');
    const response = await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'private-identity.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const file = await prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: getString(body(response), 'id') },
    });
    return file;
  }

  function verdict(
    file: ApplicationDocumentFile,
    clean = true,
  ): DocumentScanVerdict {
    return {
      bucket: file.bucket,
      key: file.storageKey,
      versionId: file.versionId ?? '',
      etag: file.etag ?? '',
      occurredAt: new Date(),
      verdict: clean ? 'COMPLETED/NO_THREATS_FOUND' : 'COMPLETED/THREATS_FOUND',
      clean,
    };
  }

  async function finalize(file: ApplicationDocumentFile) {
    await app
      .get(ApplicationDocumentFinalizationService)
      .process(verdict(file));
  }

  it('creates safe requests, distinguishes OTHER labels, and rejects normalized duplicates atomically', async () => {
    const response = await provider.agent
      .post(path('provider'))
      .send({
        requests: [
          { type: 'SCHUFA' },
          { type: 'OTHER', customLabel: '  Arbeitsvertrag  ' },
          { type: 'OTHER', customLabel: 'Mietschuldenfreiheitsbescheinigung' },
        ],
      })
      .expect(201);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'OTHER',
          customLabel: 'Arbeitsvertrag',
          status: 'UPLOAD_REQUIRED',
          canUpload: false,
          canRequestReplacement: true,
        }),
      ]),
    );
    const createdList = await provider.agent.get(path('provider')).expect(200);
    expect(createdList.body).toEqual(response.body);
    await provider.agent
      .post(path('provider'))
      .send({
        requests: [
          { type: 'INCOME_PROOF' },
          { type: 'OTHER', customLabel: 'ARBEITSVERTRAG' },
        ],
      })
      .expect(409);
    expect(await prisma.applicationDocumentRequest.count()).toBe(3);
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_REQUESTED },
      }),
    ).toBe(3);
    expect(JSON.stringify(response.body)).not.toMatch(
      /providerId|applicantId|storageKey|bucket|passwordHash|income|versionId|checksum/,
    );
  });

  it('supports maximum-length Unicode labels whose case normalization expands', async () => {
    const customLabel = 'İ'.repeat(100);
    await provider.agent
      .post(path('provider'))
      .send({ requests: [{ type: 'OTHER', customLabel }] })
      .expect(201);
    await provider.agent
      .post(path('provider'))
      .send({ requests: [{ type: 'OTHER', customLabel }] })
      .expect(409);
    expect(await prisma.applicationDocumentRequest.count()).toBe(1);
  });

  it.each([
    { type: 'OTHER' },
    { type: 'OTHER', customLabel: '<script>' },
    { type: 'SCHUFA', customLabel: 'invalid' },
    { type: 'UNKNOWN' },
    { type: 'OTHER', customLabel: '\t' },
  ])('rejects invalid request input %j', async (input) => {
    await provider.agent
      .post(path('provider'))
      .send({ requests: [input] })
      .expect(400);
    expect(await prisma.applicationDocumentRequest.count()).toBe(0);
  });

  it('enforces roles, ownership, cross-application scope and WAITING anonymity before upload', async () => {
    const requestId = await createRequest();
    await request(server).get(path('provider')).ca(certificate).expect(401);
    await applicant.agent
      .post(path('provider'))
      .send({ requests: [{ type: 'SCHUFA' }] })
      .expect(403);
    await provider.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(403);
    const otherProvider = await register('provider');
    const otherApplicant = await register('applicant');
    await otherProvider.agent.get(path('provider')).expect(404);
    await otherApplicant.agent.get(path('applicant')).expect(404);
    await otherApplicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
    await applicant.agent
      .post(path('applicant', `/document-requests/${randomUUID()}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.WAITING },
    });
    await provider.agent.get(path('provider')).expect(404);
    await provider.agent
      .post(path('provider'))
      .send({ requests: [{ type: 'INCOME_PROOF' }] })
      .expect(404);
    await provider.agent
      .get(`/api/v1/provider/applications/${applicationId}/activity`)
      .expect(404);
    await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(409);
    const result = await applicant.agent.get(path('applicant')).expect(200);
    expect(result.body).toEqual([
      expect.objectContaining({ canUpload: false }),
    ]);
  });

  it('rejects real cross-application IDs even when both applications have the same owners', async () => {
    const primaryRequest = await createRequest();
    const secondListing = await prisma.listing.create({
      data: {
        providerId: provider.id,
        displayOrder: 2,
        status: ListingStatus.PUBLISHED,
      },
    });
    const secondApplication = await prisma.application.create({
      data: {
        listingId: secondListing.id,
        applicantId: applicant.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    const [secondRequest] = await app
      .get(ApplicationDocumentRequestService)
      .create(secondApplication.id, provider.id, [
        { type: ApplicationDocumentType.SCHUFA },
      ]);
    const storage = app.get(ApplicationDocumentStorageService);
    const put = jest
      .spyOn(storage, 'put')
      .mockImplementation((file) =>
        Promise.resolve({ versionId: `version-${file.id}`, etag: 'e2e-etag' }),
      );
    const crossUpload = path(
      'applicant',
      `/document-requests/${secondRequest.id}/document`,
    );
    await applicant.agent
      .post(crossUpload)
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
    expect(put).not.toHaveBeenCalled();
    const received = await applicant.agent
      .post(
        `/api/v1/applicant/applications/${secondApplication.id}/document-requests/${secondRequest.id}/document`,
      )
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const file = await prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: getString(body(received), 'id') },
    });
    jest.spyOn(storage, 'evidence').mockResolvedValue('CLEAN');
    await finalize(file);
    const download = jest
      .spyOn(storage, 'download')
      .mockImplementation(() => Promise.resolve(new StreamableFile(pdf)));
    const beforeRequests = await prisma.applicationDocumentRequest.findMany({
      orderBy: { id: 'asc' },
    });
    const beforeFiles = await prisma.applicationDocumentFile.findMany({
      orderBy: { id: 'asc' },
    });
    const beforeActivities = await prisma.applicationActivity.findMany({
      orderBy: { id: 'asc' },
    });
    await provider.agent
      .get(path('provider', `/documents/${file.id}/content`))
      .expect(404);
    await applicant.agent
      .get(path('applicant', `/documents/${file.id}/content`))
      .expect(404);
    expect(download).not.toHaveBeenCalled();
    await provider.agent
      .post(path('provider', `/documents/${file.id}/review`))
      .send({ status: 'REVIEWED' })
      .expect(404);
    await provider.agent
      .post(
        path('provider', `/document-requests/${secondRequest.id}/replacements`),
      )
      .send({})
      .expect(404);
    await applicant.agent
      .post(
        `/api/v1/applicant/applications/${secondApplication.id}/document-requests/${primaryRequest}/document`,
      )
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      await prisma.applicationDocumentRequest.findMany({
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforeRequests);
    expect(
      await prisma.applicationDocumentFile.findMany({ orderBy: { id: 'asc' } }),
    ).toEqual(beforeFiles);
    expect(
      await prisma.applicationActivity.findMany({ orderBy: { id: 'asc' } }),
    ).toEqual(beforeActivities);
    await provider.agent
      .get(
        `/api/v1/provider/applications/${secondApplication.id}/documents/${file.id}/content`,
      )
      .expect(200);
  });

  it('rejects empty, mismatched, oversized, additional and unrequested files', async () => {
    const requestId = await createRequest();
    const endpoint = path(
      'applicant',
      `/document-requests/${requestId}/document`,
    );
    await applicant.agent
      .post(endpoint)
      .attach('file', Buffer.alloc(0), {
        filename: 'empty.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    await applicant.agent
      .post(endpoint)
      .attach('file', Buffer.from('not a PDF'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    await applicant.agent
      .post(endpoint)
      .attach('file', pdf, { filename: 'fake.png', contentType: 'image/png' })
      .expect(400);
    await applicant.agent
      .post(endpoint)
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'large.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);
    await applicant.agent
      .post(endpoint)
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    await applicant.agent
      .post(endpoint)
      .field('type', 'SCHUFA')
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(await prisma.applicationDocumentFile.count()).toBe(0);
  });

  it('keeps uploads PROCESSING and inaccessible until clean finalization, with no filename in activity', async () => {
    const requestId = await createRequest();
    const file = await upload(requestId);
    expect(file.state).toBe(ApplicationDocumentState.PROCESSING);
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
      }),
    ).toBe(0);
    await provider.agent
      .get(path('provider', `/documents/${file.id}/content`))
      .expect(404);
    await finalize(file);
    const activity = await prisma.applicationActivity.findFirstOrThrow({
      where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
    });
    expect(activity.payload).toEqual({ requestId, documentType: 'SCHUFA' });
    expect(activity.actorUserId).toBeNull();
    expect(JSON.stringify(activity)).not.toContain('private-identity');
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'download')
      .mockImplementation(() => Promise.resolve(new StreamableFile(pdf)));
    const response = await provider.agent
      .get(path('provider', `/documents/${file.id}/content`))
      .expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    await applicant.agent
      .get(path('applicant', `/documents/${file.id}/content`))
      .expect(200);
    const other = await register('provider');
    await other.agent
      .get(path('provider', `/documents/${file.id}/content`))
      .expect(404);
    await other.agent
      .post(path('provider', `/documents/${file.id}/review`))
      .send({ status: 'REVIEWED' })
      .expect(404);
    await provider.agent
      .post(path('provider', `/documents/${file.id}/review`))
      .send({ status: 'REVIEWED' })
      .expect(201);
    await provider.agent
      .post(path('provider', `/documents/${file.id}/review`))
      .send({ status: 'REVIEWED' })
      .expect(201);
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_REVIEWED },
      }),
    ).toBe(1);
  });

  it('serializes competing uploads and idempotently finalizes concurrent duplicate deliveries', async () => {
    const requestId = await createRequest();
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'put')
      .mockImplementation((file) =>
        Promise.resolve({ versionId: `version-${file.id}`, etag: 'e2e-etag' }),
      );
    const endpoint = path(
      'applicant',
      `/document-requests/${requestId}/document`,
    );
    const uploads = await Promise.all([
      applicant.agent.post(endpoint).attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      }),
      applicant.agent.post(endpoint).attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      }),
    ]);
    expect(uploads.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const file = await prisma.applicationDocumentFile.findFirstOrThrow();
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'evidence')
      .mockResolvedValue('CLEAN');
    await Promise.all([finalize(file), finalize(file), finalize(file)]);
    expect(await prisma.applicationDocumentFile.count()).toBe(1);
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
      }),
    ).toBe(1);
  });

  it('serializes duplicate predefined requests and competing replacement rounds', async () => {
    const requests = app.get(ApplicationDocumentRequestService);
    const input = [{ type: ApplicationDocumentType.SCHUFA }];
    const results = await Promise.allSettled([
      requests.create(applicationId, provider.id, input),
      requests.create(applicationId, provider.id, input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const first = await prisma.applicationDocumentRequest.findFirstOrThrow();
    const replacements = await Promise.allSettled([
      requests.replace(applicationId, first.id, provider.id),
      requests.replace(applicationId, first.id, provider.id),
    ]);
    expect(replacements.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await prisma.applicationDocumentRequest.count()).toBe(2);
  });

  it('preserves reviewed history and immutable storage keys when creating a replacement', async () => {
    const requestId = await createRequest();
    const first = await upload(requestId);
    await finalize(first);
    await app
      .get(ApplicationDocumentService)
      .review(applicationId, first.id, provider.id);
    const result = await provider.agent
      .post(path('provider', `/document-requests/${requestId}/replacements`))
      .send({})
      .expect(201);
    expect(result.body).toEqual(
      expect.objectContaining({
        canUpload: false,
        canRequestReplacement: true,
      }),
    );
    const replacementList = await provider.agent
      .get(path('provider'))
      .expect(200);
    expect(replacementList.body).toEqual(expect.arrayContaining([result.body]));
    const second = await upload(getString(body(result), 'id'));
    expect(second.storageKey).not.toBe(first.storageKey);
    expect(second.requestId).not.toBe(first.requestId);
    const previous = await prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(previous.availableAt).not.toBeNull();
    expect(previous.reviewedAt).not.toBeNull();
    const list = await provider.agent.get(path('provider')).expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requestId, status: 'SUPERSEDED' }),
        expect.objectContaining({ round: 2, status: 'PROCESSING' }),
      ]),
    );
  });

  it('ignores stale versions and old attempts without changing the current replacement', async () => {
    const requestId = await createRequest();
    const first = await upload(requestId);
    await app
      .get(ApplicationDocumentFinalizationService)
      .process({ ...verdict(first), versionId: 'wrong-version' });
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).state,
    ).toBe('PROCESSING');
    const replacement = await app
      .get(ApplicationDocumentRequestService)
      .replace(applicationId, requestId, provider.id);
    const second = await upload(replacement.id);
    await finalize(first);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).state,
    ).toBe('FAILED');
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: second.id },
        })
      ).state,
    ).toBe('PROCESSING');
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
      }),
    ).toBe(0);
  });

  it.each([
    'COMPLETED/THREATS_FOUND',
    'FAILED/FAILED',
    'SKIPPED/UNSUPPORTED',
    'SKIPPED/ACCESS_DENIED',
    'TAGGING_FAILED',
  ])(
    'never publishes %s or allows a late clean verdict to revive it',
    async (result) => {
      const file = await upload(await createRequest());
      await app
        .get(ApplicationDocumentFinalizationService)
        .process({ ...verdict(file, false), verdict: result });
      await finalize(file);
      expect(
        (
          await prisma.applicationDocumentFile.findUniqueOrThrow({
            where: { id: file.id },
          })
        ).state,
      ).toBe('FAILED');
      expect(
        await prisma.applicationActivity.count({
          where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
        }),
      ).toBe(0);
      await applicant.agent
        .get(path('applicant', `/documents/${file.id}/content`))
        .expect(404);
    },
  );

  it('revokes a previously available document when a contradictory verdict arrives', async () => {
    const requestId = await createRequest();
    const file = await upload(requestId);
    await finalize(file);
    await app
      .get(ApplicationDocumentFinalizationService)
      .process(verdict(file, false));
    const failed = await prisma.applicationDocumentFile.findUniqueOrThrow({
      where: { id: file.id },
    });
    expect(failed.state).toBe('FAILED');
    expect(failed.failureReason).toBe('CONTRADICTORY_VERDICT');
    const requests = await applicant.agent
      .get(path('applicant', '/document-requests'))
      .expect(200);
    const responseRows: unknown = requests.body;
    expect(responseRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requestId, canUpload: false }),
      ]),
    );
    await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'retry.pdf',
        contentType: 'application/pdf',
      })
      .expect(409);
    expect(
      await prisma.applicationDocumentFile.count({ where: { requestId } }),
    ).toBe(1);
    await provider.agent
      .get(path('provider', `/documents/${file.id}/content`))
      .expect(404);
    await finalize(file);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('FAILED');
  });

  it('refuses finalization on an ETag mismatch or unsafe storage evidence', async () => {
    const first = await upload(await createRequest());
    await app
      .get(ApplicationDocumentFinalizationService)
      .process({ ...verdict(first), etag: 'different' });
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).state,
    ).toBe('FAILED');
    const second = await upload(
      await createRequest(ApplicationDocumentType.INCOME_PROOF),
    );
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'evidence')
      .mockResolvedValue('UNSAFE');
    await finalize(second);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: second.id },
        })
      ).state,
    ).toBe('FAILED');
  });

  it('retries missing tags and event-before-version races, then safely finalizes', async () => {
    const file = await upload(await createRequest());
    await prisma.applicationDocumentFile.update({
      where: { id: file.id },
      data: { versionId: null },
    });
    await expect(finalize(file)).rejects.toThrow('version');
    await prisma.applicationDocumentFile.update({
      where: { id: file.id },
      data: { versionId: file.versionId },
    });
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'evidence')
      .mockResolvedValue('PENDING');
    await expect(finalize(file)).rejects.toThrow('tag');
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('PROCESSING');
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'evidence')
      .mockResolvedValue('CLEAN');
    await finalize(file);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('AVAILABLE');
  });

  it('recovers only overdue attempts and makes hard timeouts permanently inaccessible', async () => {
    const first = await upload(await createRequest());
    const second = await upload(
      await createRequest(ApplicationDocumentType.INCOME_PROOF),
    );
    await prisma.applicationDocumentFile.update({
      where: { id: first.id },
      data: { recoverAfter: new Date(0) },
    });
    const recovery = new DocumentRecoveryService(
      prisma,
      app.get(ApplicationDocumentFinalizationService),
    );
    await recovery.run();
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).state,
    ).toBe('AVAILABLE');
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: second.id },
        })
      ).state,
    ).toBe('PROCESSING');
    await prisma.applicationDocumentFile.update({
      where: { id: second.id },
      data: { recoverAfter: new Date(0), expiresAt: new Date(0) },
    });
    await recovery.run();
    await finalize(second);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: second.id },
        })
      ).failureReason,
    ).toBe('PROCESSING_TIMEOUT');
  });

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])(
    'retains authorized history while %s disables mutations',
    async (status) => {
      const requestId = await createRequest();
      const file = await upload(requestId);
      await finalize(file);
      await prisma.application.update({
        where: { id: applicationId },
        data: { status },
      });
      await provider.agent.get(path('provider')).expect(200);
      await applicant.agent.get(path('applicant')).expect(200);
      jest
        .spyOn(app.get(ApplicationDocumentStorageService), 'download')
        .mockImplementation(() => Promise.resolve(new StreamableFile(pdf)));
      await provider.agent
        .get(path('provider', `/documents/${file.id}/content`))
        .expect(200);
      await provider.agent
        .post(path('provider'))
        .send({ requests: [{ type: 'INCOME_PROOF' }] })
        .expect(409);
      await provider.agent
        .post(path('provider', `/document-requests/${requestId}/replacements`))
        .send({})
        .expect(409);
      await provider.agent
        .post(path('provider', `/documents/${file.id}/review`))
        .send({ status: 'REVIEWED' })
        .expect(409);
    },
  );

  it('blocks RENTED mutations and pending finalization, then resumes outstanding requests on ACTIVE restoration', async () => {
    const requestId = await createRequest();
    const file = await upload(requestId);
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.RENTED },
    });
    await finalize(file);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('FAILED');
    await provider.agent
      .post(path('provider'))
      .send({ requests: [{ type: 'INCOME_PROOF' }] })
      .expect(409);
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: ListingStatus.PUBLISHED },
    });
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED },
    });
    await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(409);
    await prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.ACTIVE },
    });
    const second = await upload(requestId);
    expect(second.id).not.toBe(file.id);
    await finalize(second);
    expect(await prisma.applicationDocumentRequest.count()).toBe(1);
    expect(await prisma.applicationDocumentFile.count()).toBe(2);
  });

  it('rolls back availability and audit atomically when activity persistence fails', async () => {
    const file = await upload(await createRequest());
    jest
      .spyOn(app.get(ApplicationDocumentActivityService), 'append')
      .mockRejectedValueOnce(new Error('Activity persistence failed'));
    await expect(finalize(file)).rejects.toThrow('Activity persistence failed');
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('PROCESSING');
    expect(
      await prisma.applicationActivity.count({
        where: { type: ApplicationActivityType.DOCUMENT_UPLOADED },
      }),
    ).toBe(0);
    await finalize(file);
    expect(
      (
        await prisma.applicationDocumentFile.findUniqueOrThrow({
          where: { id: file.id },
        })
      ).state,
    ).toBe('AVAILABLE');
  });

  it('preserves failed upload history, retries safely, and requires replacement after a successful upload', async () => {
    const requestId = await createRequest();
    jest
      .spyOn(app.get(ApplicationDocumentStorageService), 'put')
      .mockRejectedValue(new Error('Storage unavailable'));
    await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(503);
    const failed = await prisma.applicationDocumentFile.findFirstOrThrow();
    expect(failed.state).toBe('FAILED');
    const success = await upload(requestId);
    await finalize(success);
    await applicant.agent
      .post(path('applicant', `/document-requests/${requestId}/document`))
      .attach('file', pdf, {
        filename: 'document.pdf',
        contentType: 'application/pdf',
      })
      .expect(409);
    expect(await prisma.applicationDocumentFile.count()).toBe(2);
  });
});
