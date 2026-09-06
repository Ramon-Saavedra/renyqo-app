import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import {
  ListingReportReason,
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
  UserStatus,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  assertSafeE2EDatabaseUrl,
  getE2EDatabaseName,
} from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type PgSessionStore = InstanceType<ReturnType<typeof connectPgSimple>>;

type RegisterPayload = {
  name: string;
  email: string;
  password: string;
  role: 'applicant' | 'provider';
  acceptedTerms: true;
  acceptedPrivacy: true;
  providerType?: 'private';
  companyName?: undefined;
};

const sessionSecret = 'e2e-session-secret-at-least-thirty-two-characters';
const userPassword = 'StrongPass123';

let app: INestApplication | undefined;
let prisma: PrismaService | undefined;
let sessionStore: PgSessionStore | undefined;
let emailSequence = 0;

function useE2eEnvironment(): void {
  const databaseUrl = process.env['E2E_DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('E2E_DATABASE_URL is required for destructive E2E tests.');
  }

  const e2eDatabaseName = getE2EDatabaseName(databaseUrl);

  if (process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
    throw new Error(
      'E2E_DATABASE_ALLOW_RESET=true is required for destructive E2E tests.',
    );
  }

  process.env['NODE_ENV'] = 'test';
  process.env['PORT'] = '3000';
  process.env['DATABASE_URL'] = databaseUrl;
  if (getE2EDatabaseName(process.env['DATABASE_URL']) !== e2eDatabaseName) {
    throw new Error(
      'DATABASE_URL and E2E_DATABASE_URL must target the same E2E database.',
    );
  }
  process.env['SESSION_SECRET'] = sessionSecret;
  process.env['FRONTEND_URL'] = 'http://localhost:3001';
  process.env['OPENAI_API_KEY'] = 'e2e-openai-api-key';
  process.env['OPENAI_LISTING_MODEL'] = 'e2e-listing-model';
  process.env['OPENAI_TRANSCRIPTION_MODEL'] = 'e2e-transcription-model';
  process.env['AI_RATE_LIMIT_WINDOW_MS'] = '60000';
  process.env['AI_TEXT_RATE_LIMIT'] = '10';
  process.env['AI_PDF_RATE_LIMIT'] = '3';
  process.env['AI_AUDIO_RATE_LIMIT'] = '3';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRequestTarget(value: unknown): value is RequestTarget {
  return (
    typeof value === 'string' ||
    value instanceof URL ||
    (typeof value === 'object' && value !== null)
  );
}

function getServer(): RequestTarget {
  if (!app) {
    throw new Error('E2E app has not been initialized.');
  }

  const server: unknown = app.getHttpServer();
  if (!isRequestTarget(server)) {
    throw new Error('E2E app server is not a valid request target.');
  }

  return server;
}

function getPrisma(): PrismaService {
  if (!prisma) {
    throw new Error('Prisma service has not been initialized.');
  }

  return prisma;
}

function responseBody(response: Response): Record<string, unknown> {
  const body: unknown = response.body;
  if (!isRecord(body)) {
    throw new Error('E2E response body is not an object.');
  }

  return body;
}

async function clearDatabase(): Promise<void> {
  const e2eDatabaseUrl = process.env['E2E_DATABASE_URL'];
  const activeDatabaseUrl = process.env['DATABASE_URL'];

  if (!e2eDatabaseUrl || !activeDatabaseUrl) {
    throw new Error(
      'Destructive E2E cleanup requires both database URLs to be configured.',
    );
  }

  assertSafeE2EDatabaseUrl(e2eDatabaseUrl);
  if (
    getE2EDatabaseName(activeDatabaseUrl) !== getE2EDatabaseName(e2eDatabaseUrl)
  ) {
    throw new Error(
      'DATABASE_URL and E2E_DATABASE_URL must target the same E2E database.',
    );
  }

  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('E2E database cleanup is only allowed in test mode.');
  }

  if (process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
    throw new Error('E2E database cleanup requires the reset safety marker.');
  }

  if (!prisma) {
    throw new Error('Prisma service has not been initialized.');
  }

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
}

function uniqueEmail(prefix: string): string {
  emailSequence += 1;
  return `${prefix}-${emailSequence}@e2e.renyqo.test`;
}

function applicantPayload(email = uniqueEmail('applicant')): RegisterPayload {
  return {
    name: 'Renyqo Applicant',
    email,
    password: userPassword,
    role: 'applicant',
    acceptedTerms: true,
    acceptedPrivacy: true,
  };
}

function providerPayload(email = uniqueEmail('provider')): RegisterPayload {
  return {
    name: 'Renyqo Provider',
    email,
    password: userPassword,
    role: 'provider',
    providerType: 'private',
    acceptedTerms: true,
    acceptedPrivacy: true,
  };
}

async function registerAndGetCookies(
  payload: RegisterPayload,
): Promise<string[]> {
  const res = await request(getServer())
    .post('/api/v1/auth/register')
    .send(payload)
    .expect(201);

  const cookies = res.headers['set-cookie'];
  if (!Array.isArray(cookies)) {
    throw new Error('Expected set-cookie array');
  }

  return cookies as string[];
}

async function createPublishedListing(
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  const base = {
    providerId,
    status: ListingStatus.PUBLISHED,
    city: 'Berlin',
    zip: '10115',
    title: 'E2E Test Listing',
    coldRent: 1200,
    additionalCosts: 250,
    deposit: 2400,
    depositMonths: 2,
    livingArea: 62.5,
    rooms: 2,
    bedrooms: 1,
    availableFrom: new Date('2026-09-01'),
    publishedAt: new Date(),
    shortDescription: 'A nice test listing',
    showExactAddress: false,
    street: 'Teststrasse 1',
    objectType: ObjectType.APARTMENT,
    minimumHouseholdNetIncome: 3000,
    schufaRequired: true,
    incomeProofRequired: false,
    suitableForPeopleCount: 2,
    petsPolicy: PetsPolicy.ALLOWED,
    smokingPolicy: SmokingPolicy.NOT_ALLOWED,
    ...overrides,
  };

  return getPrisma().listing.create({ data: base });
}

async function createDraftListing(providerId: string) {
  return getPrisma().listing.create({
    data: {
      providerId,
      status: ListingStatus.DRAFT,
      city: 'Berlin',
      zip: '10115',
      title: 'Draft Listing',
    },
  });
}

describe('Applicant Listing Actions E2E', () => {
  jest.setTimeout(30_000);

  beforeAll(async () => {
    useE2eEnvironment();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );

    const config = app.get(ConfigService<EnvironmentVariables, true>);
    const PgSessionStore = connectPgSimple(session);

    sessionStore = new PgSessionStore({
      conString: config.getOrThrow<string>('DATABASE_URL'),
      tableName: 'user_sessions',
      createTableIfMissing: false,
    });

    app.use(
      session({
        store: sessionStore,
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
          maxAge: 24 * 60 * 60 * 1000,
        },
      }),
    );

    app.use(passport.initialize());
    app.use(passport.session());

    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  }, 15_000);

  beforeEach(async () => {
    await clearDatabase();
  });

  describe('authentication', () => {
    const LISTING_ID = '00000000-0000-4000-8000-000000000001';

    it('returns 401 for unauthenticated save', async () => {
      await request(getServer())
        .put(`/api/v1/applicant/listings/${LISTING_ID}/saved`)
        .expect(401);
    });

    it('returns 401 for unauthenticated unsave', async () => {
      await request(getServer())
        .delete(`/api/v1/applicant/listings/${LISTING_ID}/saved`)
        .expect(401);
    });

    it('returns 401 for unauthenticated report', async () => {
      await request(getServer())
        .post(`/api/v1/applicant/listings/${LISTING_ID}/report`)
        .send({ reason: ListingReportReason.MISLEADING_INFO })
        .expect(401);
    });

    it('returns 401 for unauthenticated saved-listings read', async () => {
      await request(getServer())
        .get('/api/v1/applicant/saved-listings')
        .expect(401);
    });
  });

  describe('PUT /api/v1/applicant/listings/:listingId/saved', () => {
    it('saves a published listing idempotently', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      const first = await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);
      const second = await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      expect(responseBody(first).saved).toBe(true);
      expect(responseBody(first).savedAt).toBeTruthy();
      expect(responseBody(second).saved).toBe(true);
      expect(responseBody(second).savedAt).toBeTruthy();

      const savedCount = await getPrisma().savedListing.count({
        where: { listingId: listing.id },
      });
      expect(savedCount).toBe(1);
    });

    it('returns 404 for unpublished listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createDraftListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(404);
    });

    it('rejects provider sessions', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await request(getServer())
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .set('Cookie', providerCookies)
        .expect(403);
    });
  });

  describe('DELETE /api/v1/applicant/listings/:listingId/saved', () => {
    it('unsaves a listing idempotently', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      const first = await applicantAgent
        .delete(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);
      const second = await applicantAgent
        .delete(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      expect(responseBody(first)).toEqual({ saved: false, savedAt: null });
      expect(responseBody(second)).toEqual({ saved: false, savedAt: null });

      const savedCount = await getPrisma().savedListing.count({
        where: { listingId: listing.id },
      });
      expect(savedCount).toBe(0);
    });

    it('rejects provider sessions', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await request(getServer())
        .delete(`/api/v1/applicant/listings/${listing.id}/saved`)
        .set('Cookie', providerCookies)
        .expect(403);
    });
  });

  describe('POST /api/v1/applicant/listings/:listingId/report', () => {
    it('creates a report without exposing reporter identity', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      const response = await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.MISLEADING_INFO })
        .expect(201);

      const body = responseBody(response);
      expect(body.listingId).toBe(listing.id);
      expect(body.reason).toBe(ListingReportReason.MISLEADING_INFO);
      expect(body.id).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      expect(body).not.toHaveProperty('reporterApplicantId');
      expect(body).not.toHaveProperty('detail');
    });

    it('rejects OTHER without detail', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.OTHER })
        .expect(400);
    });

    it('accepts OTHER with detail', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({
          reason: ListingReportReason.OTHER,
          detail: '  Needs review  ',
        })
        .expect(201);

      const stored = await getPrisma().listingReport.findFirst({
        where: { listingId: listing.id },
      });
      expect(stored?.detail).toBe('Needs review');
    });

    it('returns 409 for duplicate reports', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.DUPLICATE_OR_SPAM })
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.SCAM_OR_FRAUD })
        .expect(409);
    });

    it('returns 404 for unpublished listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createDraftListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.INAPPROPRIATE_CONTENT })
        .expect(404);
    });

    it('does not mutate listing status', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .send({ reason: ListingReportReason.DISCRIMINATION })
        .expect(201);

      const refreshed = await getPrisma().listing.findUnique({
        where: { id: listing.id },
      });
      expect(refreshed?.status).toBe(ListingStatus.PUBLISHED);
      expect(refreshed?.publishedAt).not.toBeNull();
    });

    it('rate limits reports to five per hour per applicant', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      for (let index = 0; index < 5; index += 1) {
        const listing = await createPublishedListing(providerId, {
          title: `Report Target ${index}`,
        });
        await applicantAgent
          .post(`/api/v1/applicant/listings/${listing.id}/report`)
          .send({ reason: ListingReportReason.MISLEADING_INFO })
          .expect(201);
      }

      const sixthListing = await createPublishedListing(providerId, {
        title: 'Report Target 6',
      });

      const limited = await applicantAgent
        .post(`/api/v1/applicant/listings/${sixthListing.id}/report`)
        .send({ reason: ListingReportReason.MISLEADING_INFO })
        .expect(429);

      expect(responseBody(limited).code).toBe('LISTING_REPORT_RATE_LIMITED');
    });

    it('rejects provider sessions', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await request(getServer())
        .post(`/api/v1/applicant/listings/${listing.id}/report`)
        .set('Cookie', providerCookies)
        .send({ reason: ListingReportReason.MISLEADING_INFO })
        .expect(403);
    });
  });

  describe('isSaved on discovery endpoints', () => {
    it('exposes isSaved on collection and detail for saved listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const savedListing = await createPublishedListing(providerId, {
        title: 'Saved Listing',
      });
      const otherListing = await createPublishedListing(providerId, {
        title: 'Other Listing',
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${savedListing.id}/saved`)
        .expect(200);

      const collection = await applicantAgent
        .get('/api/v1/listings')
        .expect(200);
      const items = responseBody(collection).items as Record<string, unknown>[];
      const savedItem = items.find((item) => item.id === savedListing.id);
      const otherItem = items.find((item) => item.id === otherListing.id);

      if (!savedItem || !otherItem) {
        throw new Error('Expected both listings in discovery response.');
      }

      expect(savedItem.isSaved).toBe(true);
      expect(otherItem.isSaved).toBe(false);

      const detail = await applicantAgent
        .get(`/api/v1/listings/${savedListing.id}`)
        .expect(200);
      expect(responseBody(detail).isSaved).toBe(true);
    });

    it('returns isSaved false for anonymous and provider sessions', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      const anonymousCollection = await request(getServer())
        .get('/api/v1/listings')
        .expect(200);
      const anonymousItems = responseBody(anonymousCollection).items as Record<
        string,
        unknown
      >[];
      expect(anonymousItems[0].isSaved).toBe(false);

      const anonymousDetail = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .expect(200);
      expect(responseBody(anonymousDetail).isSaved).toBe(false);

      const providerCollection = await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerItems = responseBody(providerCollection).items as Record<
        string,
        unknown
      >[];
      expect(providerItems[0].isSaved).toBe(false);
    });
  });

  describe('GET /api/v1/applicant/saved-listings', () => {
    it('returns saved published listings with isSaved true', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const savedListing = await createPublishedListing(providerId, {
        title: 'Saved Listing',
      });
      const otherListing = await createPublishedListing(providerId, {
        title: 'Other Listing',
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${savedListing.id}/saved`)
        .expect(200);

      const response = await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .expect(200);
      const body = responseBody(response);
      const items = body.items as Record<string, unknown>[];

      expect(body.total).toBe(1);
      expect(body.nextCursor).toBeNull();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(savedListing.id);
      expect(items[0].isSaved).toBe(true);
      expect(items[0].title).toBe('Saved Listing');
      expect(items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: otherListing.id }),
        ]),
      );
      expect(items[0]).not.toHaveProperty('savedAt');
    });

    it('omits saved rows for non-public listings while keeping them persisted', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId, {
        title: 'Will Be Paused',
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      await getPrisma().listing.update({
        where: { id: listing.id },
        data: { status: ListingStatus.PAUSED },
      });

      const response = await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .expect(200);
      const body = responseBody(response);

      expect(body.total).toBe(0);
      expect(body.items).toHaveLength(0);

      const persistedCount = await getPrisma().savedListing.count({
        where: { listingId: listing.id },
      });
      expect(persistedCount).toBe(1);
    });

    it('returns only the authenticated applicant saved listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const firstListing = await createPublishedListing(providerId, {
        title: 'First Applicant Listing',
      });
      const secondListing = await createPublishedListing(providerId, {
        title: 'Second Applicant Listing',
      });

      const firstApplicant = request.agent(getServer());
      await firstApplicant
        .post('/api/v1/auth/register')
        .send(applicantPayload(uniqueEmail('first-applicant')))
        .expect(201);
      await firstApplicant
        .put(`/api/v1/applicant/listings/${firstListing.id}/saved`)
        .expect(200);

      const secondApplicant = request.agent(getServer());
      await secondApplicant
        .post('/api/v1/auth/register')
        .send(applicantPayload(uniqueEmail('second-applicant')))
        .expect(201);
      await secondApplicant
        .put(`/api/v1/applicant/listings/${secondListing.id}/saved`)
        .expect(200);

      const firstResponse = await firstApplicant
        .get('/api/v1/applicant/saved-listings')
        .expect(200);
      const secondResponse = await secondApplicant
        .get('/api/v1/applicant/saved-listings')
        .expect(200);

      const firstItems = responseBody(firstResponse).items as Record<
        string,
        unknown
      >[];
      const secondItems = responseBody(secondResponse).items as Record<
        string,
        unknown
      >[];

      expect(firstItems).toHaveLength(1);
      expect(firstItems[0].id).toBe(firstListing.id);
      expect(secondItems).toHaveLength(1);
      expect(secondItems[0].id).toBe(secondListing.id);
    });

    it('orders saved listings newest first and paginates with cursor', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const oldest = await createPublishedListing(providerId, {
        title: 'Oldest Saved',
      });
      const middle = await createPublishedListing(providerId, {
        title: 'Middle Saved',
      });
      const newest = await createPublishedListing(providerId, {
        title: 'Newest Saved',
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      for (const listing of [oldest, middle, newest]) {
        await applicantAgent
          .put(`/api/v1/applicant/listings/${listing.id}/saved`)
          .expect(200);
      }

      await getPrisma().savedListing.updateMany({
        where: { listingId: oldest.id },
        data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      });
      await getPrisma().savedListing.updateMany({
        where: { listingId: middle.id },
        data: { createdAt: new Date('2026-01-02T00:00:00.000Z') },
      });
      await getPrisma().savedListing.updateMany({
        where: { listingId: newest.id },
        data: { createdAt: new Date('2026-01-03T00:00:00.000Z') },
      });

      const firstPage = await applicantAgent
        .get('/api/v1/applicant/saved-listings?limit=2')
        .expect(200);
      const firstBody = responseBody(firstPage);
      const firstItems = firstBody.items as Record<string, unknown>[];

      expect(firstBody.total).toBe(3);
      expect(firstItems).toHaveLength(2);
      expect(firstItems[0].id).toBe(newest.id);
      expect(firstItems[1].id).toBe(middle.id);
      expect(firstBody.nextCursor).toBeTruthy();

      const secondPage = await applicantAgent
        .get(
          `/api/v1/applicant/saved-listings?limit=2&cursor=${encodeURIComponent(String(firstBody.nextCursor))}`,
        )
        .expect(200);
      const secondBody = responseBody(secondPage);
      const secondItems = secondBody.items as Record<string, unknown>[];

      expect(secondItems).toHaveLength(1);
      expect(secondItems[0].id).toBe(oldest.id);
      expect(secondBody.nextCursor).toBeNull();
    });

    it('exposes application state on saved listing summaries', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId, {
        title: 'Applied Saved Listing',
        minimumHouseholdNetIncome: null,
        schufaRequired: false,
        incomeProofRequired: false,
        suitableForPeopleCount: null,
        petsPolicy: null,
        smokingPolicy: null,
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);
      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);

      const response = await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .expect(200);
      const items = responseBody(response).items as Record<string, unknown>[];

      expect(items).toHaveLength(1);
      expect(items[0].isSaved).toBe(true);
      expect(items[0].hasApplied).toBe(true);
      expect(items[0].applicationStatus).toBe('ACTIVE');
      expect(items[0].publicReason).toBeNull();
    });

    it('rejects provider sessions', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());

      await request(getServer())
        .get('/api/v1/applicant/saved-listings')
        .set('Cookie', providerCookies)
        .expect(403);
    });

    it('rejects non-ACTIVE applicant sessions', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      const meRes = await applicantAgent.get('/api/v1/auth/me').expect(200);
      const applicantId = responseBody(meRes).id as string;

      await getPrisma().user.update({
        where: { id: applicantId },
        data: { status: UserStatus.SUSPENDED },
      });

      await applicantAgent.get('/api/v1/applicant/saved-listings').expect(401);
    });

    it('returns 400 for malformed saved-listings cursors', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .query({ cursor: 'x'.repeat(300) })
        .expect(400);

      await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .query({ cursor: 'not-valid-base64!!' })
        .expect(400);

      const invalidDateCursor = Buffer.from(
        JSON.stringify({
          savedAt: 'not-a-date',
          id: '00000000-0000-4000-8000-000000000001',
        }),
      ).toString('base64url');

      await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .query({ cursor: invalidDateCursor })
        .expect(400);

      const invalidUuidCursor = Buffer.from(
        JSON.stringify({
          savedAt: new Date().toISOString(),
          id: 'not-a-uuid',
        }),
      ).toString('base64url');

      await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .query({ cursor: invalidUuidCursor })
        .expect(400);
    });

    it('preserves the same profileMatch as discovery for saved listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId, {
        title: 'Profile Match Listing',
        minimumHouseholdNetIncome: null,
        schufaRequired: false,
        incomeProofRequired: false,
        suitableForPeopleCount: null,
        petsPolicy: null,
        smokingPolicy: null,
      });

      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .put(`/api/v1/applicant/listings/${listing.id}/saved`)
        .expect(200);

      const discoveryResponse = await applicantAgent
        .get('/api/v1/listings')
        .expect(200);
      const savedResponse = await applicantAgent
        .get('/api/v1/applicant/saved-listings')
        .expect(200);

      const discoveryItems = responseBody(discoveryResponse).items as Record<
        string,
        unknown
      >[];
      const savedItems = responseBody(savedResponse).items as Record<
        string,
        unknown
      >[];

      const discoveryItem = discoveryItems.find(
        (item) => item.id === listing.id,
      );
      const savedItem = savedItems.find((item) => item.id === listing.id);

      if (!discoveryItem || !savedItem) {
        throw new Error('Expected listing in discovery and saved-listings.');
      }

      expect(savedItem.profileMatch).toBe(discoveryItem.profileMatch);
      expect(savedItem.profileMatch).toBe('PROFILE_INCOMPLETE');
    });
  });
});
