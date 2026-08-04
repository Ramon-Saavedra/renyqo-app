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
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
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

function expectSessionCookie(response: Response): void {
  expect(response.headers['set-cookie']).toBeDefined();
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
  await prisma.listingImage.deleteMany();
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

  expectSessionCookie(res);

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
    smokingPolicy: SmokingPolicy.NON_SMOKERS_PREFERRED,
    ...overrides,
  };

  return getPrisma().listing.create({ data: base });
}

describe('Applicant Discovery E2E', () => {
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

  describe('GET /api/v1/listings', () => {
    it('returns an empty page for unauthenticated requests', async () => {
      const response = await request(getServer())
        .get('/api/v1/listings')
        .expect(200);

      expect(responseBody(response).items).toEqual([]);
    });

    it('allows provider requests', async () => {
      const cookies = await registerAndGetCookies(providerPayload());

      await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', cookies)
        .expect(200);
    });

    it('returns an empty page when no listings are published', async () => {
      const cookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', cookies)
        .expect(200);

      const body = responseBody(res);
      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('returns published listings for an anonymous user', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      await createPublishedListing(providerId);
      await createPublishedListing(providerId, { title: 'Second Listing' });

      const res = await request(getServer())
        .get('/api/v1/listings')
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe('Second Listing');
      expect(items[1].title).toBe('E2E Test Listing');
    });

    it('excludes non-published listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      await createPublishedListing(providerId);
      await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.DRAFT,
          city: 'Berlin',
          title: 'Draft Listing',
        },
      });
      await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.ARCHIVED,
          publishedAt: new Date(),
          city: 'Berlin',
          title: 'Archived Listing',
        },
      });
      await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.PAUSED,
          publishedAt: new Date(),
          city: 'Berlin',
          title: 'Paused Listing',
        },
      });
      await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.RENTED,
          publishedAt: new Date(),
          rentedAt: new Date(),
          city: 'Berlin',
          title: 'Rented Listing',
        },
      });

      const res = await request(getServer())
        .get('/api/v1/listings')
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('E2E Test Listing');
    });

    it('filters by city', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      await createPublishedListing(providerId, { city: 'Berlin' });
      await createPublishedListing(providerId, { city: 'Munich' });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const berlin = await request(getServer())
        .get('/api/v1/listings')
        .query({ city: 'Berlin' })
        .set('Cookie', applicantCookies)
        .expect(200);

      const berlinBody = responseBody(berlin);
      const berlinItems = berlinBody.items as Record<string, unknown>[];
      expect(berlinItems).toHaveLength(1);
      expect(berlinItems[0].city).toBe('Berlin');

      const munich = await request(getServer())
        .get('/api/v1/listings')
        .query({ city: 'munich' })
        .set('Cookie', applicantCookies)
        .expect(200);

      const munichBody = responseBody(munich);
      const munichItems = munichBody.items as Record<string, unknown>[];
      expect(munichItems).toHaveLength(1);
      expect(munichItems[0].city).toBe('Munich');
    });

    it('filters by rent range', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      await createPublishedListing(providerId, {
        coldRent: 800,
        deposit: 1600,
        title: 'Cheap',
      });
      await createPublishedListing(providerId, {
        coldRent: 1500,
        deposit: 3000,
        title: 'Expensive',
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .query({ minRent: 1000, maxRent: 2000 })
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Expensive');
    });

    it('never exposes providerId in responses', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      await createPublishedListing(providerId);

      const res = await request(getServer())
        .get('/api/v1/listings')
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items[0]).not.toHaveProperty('providerId');
      expect(items[0]).not.toHaveProperty('showExactAddress');
    });

    it('includes coverImage with only secureUrl', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await getPrisma().listingImage.create({
        data: {
          listingId: listing.id,
          publicId: `e2e/listings/${listing.id}/cover`,
          secureUrl: 'https://example.com/cover.jpg',
          position: 0,
          isCover: true,
        },
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      const coverImage = items[0].coverImage as Record<string, unknown>;
      expect(coverImage.secureUrl).toBe('https://example.com/cover.jpg');
      expect(coverImage).not.toHaveProperty('publicId');
    });

    it('includes null coverImage when listing has no images', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      await createPublishedListing(providerId);

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items[0].coverImage).toBeNull();
    });
  });

  describe('GET /api/v1/listings/:id', () => {
    it('returns 404 for an unauthenticated request for a missing listing', async () => {
      await request(getServer())
        .get('/api/v1/listings/00000000-0000-4000-8000-000000000001')
        .expect(404);
    });

    it('allows provider requests for published listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', providerCookies)
        .expect(200);
    });

    it('returns 404 for non-published listings', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      const statuses = [
        ListingStatus.DRAFT,
        ListingStatus.PAUSED,
        ListingStatus.ARCHIVED,
        ListingStatus.RENTED,
      ];

      for (const status of statuses) {
        const listing = await getPrisma().listing.create({
          data: {
            providerId,
            status,
            title: `${status} Listing`,
            publishedAt: status === ListingStatus.DRAFT ? null : new Date(),
            rentedAt: status === ListingStatus.RENTED ? new Date() : null,
          },
        });

        await request(getServer())
          .get(`/api/v1/listings/${listing.id}`)
          .expect(404);
      }
    });

    it('returns public-safe published listing detail anonymously', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .expect(200);

      const body = responseBody(res);
      expect(body.id).toBe(listing.id);
      expect(body.title).toBe('E2E Test Listing');
      expect(body.city).toBe('Berlin');
      expect(body.zip).toBe('10115');
      expect(body).not.toHaveProperty('providerId');
      expect(body).not.toHaveProperty('provider');
      expect(body).not.toHaveProperty('showExactAddress');
      expect(body).not.toHaveProperty('eligibility');
      expect(body).not.toHaveProperty('canApply');
      expect(body).not.toHaveProperty('reasons');
      expect(body).not.toHaveProperty('warnings');
      expect(body).not.toHaveProperty('evaluatedAt');
    });

    it('hides street when showExactAddress is false', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId, {
        showExactAddress: false,
        street: 'Teststrasse 1',
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      expect(body.street).toBeNull();
    });

    it('shows street when showExactAddress is true', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId, {
        showExactAddress: true,
        street: 'Teststrasse 1',
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      expect(body.street).toBe('Teststrasse 1');
    });

    it('never exposes showExactAddress flag', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      expect(body).not.toHaveProperty('showExactAddress');
    });

    it('never exposes providerId', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      expect(body).not.toHaveProperty('providerId');
    });

    it('includes public application requirements', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const requirements = body.requirements as Record<string, unknown>;
      expect(requirements).toHaveProperty('minimumHouseholdNetIncome');
      expect(requirements).toHaveProperty('schufaRequired');
      expect(requirements).toHaveProperty('incomeProofRequired');
      expect(requirements).toHaveProperty('suitableForPeopleCount');
      expect(requirements).toHaveProperty('petsPolicy');
      expect(requirements).toHaveProperty('smokingPolicy');
    });

    it('includes public images without publicId', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;
      const listing = await createPublishedListing(providerId);

      await getPrisma().listingImage.create({
        data: {
          listingId: listing.id,
          publicId: `e2e/listings/${listing.id}/img`,
          secureUrl: 'https://example.com/img.jpg',
          position: 0,
          isCover: true,
        },
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get(`/api/v1/listings/${listing.id}`)
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const images = body.images as Record<string, unknown>[];
      expect(images[0].secureUrl).toBe('https://example.com/img.jpg');
      expect(images[0]).not.toHaveProperty('publicId');
    });
  });

  describe('cursor pagination', () => {
    it('supports cursor-based pagination', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      for (let i = 0; i < 5; i += 1) {
        await createPublishedListing(providerId, {
          title: `Listing ${i}`,
          publishedAt: new Date(2026, 6, 1 + i, 12, 0, 0),
        });
      }

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const page1Res = await request(getServer())
        .get('/api/v1/listings')
        .query({ limit: 2 })
        .set('Cookie', applicantCookies)
        .expect(200);

      const page1 = responseBody(page1Res);
      const page1Items = page1.items as Record<string, unknown>[];
      expect(page1Items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1Items[0].title).toBe('Listing 4');
      expect(page1Items[1].title).toBe('Listing 3');

      const page2Res = await request(getServer())
        .get('/api/v1/listings')
        .query({ limit: 2, cursor: page1.nextCursor as string })
        .set('Cookie', applicantCookies)
        .expect(200);

      const page2 = responseBody(page2Res);
      const page2Items = page2.items as Record<string, unknown>[];
      expect(page2Items).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();
      expect(page2Items[0].title).toBe('Listing 2');
      expect(page2Items[1].title).toBe('Listing 1');

      const page3Res = await request(getServer())
        .get('/api/v1/listings')
        .query({ limit: 2, cursor: page2.nextCursor as string })
        .set('Cookie', applicantCookies)
        .expect(200);

      const page3 = responseBody(page3Res);
      const page3Items = page3.items as Record<string, unknown>[];
      expect(page3Items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
      expect(page3Items[0].title).toBe('Listing 0');

      const allIds = [...page1Items, ...page2Items, ...page3Items].map(
        (item) => item.id as string,
      );

      expect(allIds).toHaveLength(5);
      expect(new Set(allIds).size).toBe(5);

      const page1Ids = page1Items.map((item) => item.id as string);
      const page2Ids = page2Items.map((item) => item.id as string);
      const page3Ids = page3Items.map((item) => item.id as string);

      for (const id of page1Ids) {
        expect(page2Ids).not.toContain(id);
        expect(page3Ids).not.toContain(id);
      }

      for (const id of page2Ids) {
        expect(page3Ids).not.toContain(id);
      }
    });

    it('handles equal publishedAt with id tiebreaker', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      const sameDate = new Date(2026, 6, 1, 12, 0, 0);

      for (let i = 0; i < 4; i += 1) {
        await createPublishedListing(providerId, {
          title: `Tie ${i}`,
          publishedAt: sameDate,
        });
      }

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .query({ limit: 4 })
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(4);

      const ids = items.map((item) => item.id as string);

      for (let j = 1; j < ids.length; j += 1) {
        expect(ids[j]).not.toBe(ids[j - 1]);
      }
    });
  });

  describe('malformed cursor', () => {
    it('returns 400 for an oversize cursor', async () => {
      const applicantCookies = await registerAndGetCookies(applicantPayload());

      await request(getServer())
        .get('/api/v1/listings')
        .query({ cursor: 'x'.repeat(300) })
        .set('Cookie', applicantCookies)
        .expect(400);
    });

    it('returns 400 for an invalid base64 cursor', async () => {
      const applicantCookies = await registerAndGetCookies(applicantPayload());

      await request(getServer())
        .get('/api/v1/listings')
        .query({ cursor: 'not-valid-base64!!' })
        .set('Cookie', applicantCookies)
        .expect(400);
    });

    it('returns 400 for a cursor with an invalid date', async () => {
      const applicantCookies = await registerAndGetCookies(applicantPayload());
      const cursor = Buffer.from(
        JSON.stringify({
          publishedAt: 'not-a-date',
          id: '00000000-0000-4000-8000-000000000001',
        }),
      ).toString('base64url');

      await request(getServer())
        .get('/api/v1/listings')
        .query({ cursor })
        .set('Cookie', applicantCookies)
        .expect(400);
    });

    it('returns 400 for a cursor with an invalid UUID', async () => {
      const applicantCookies = await registerAndGetCookies(applicantPayload());
      const cursor = Buffer.from(
        JSON.stringify({
          publishedAt: new Date().toISOString(),
          id: 'not-a-uuid',
        }),
      ).toString('base64url');

      await request(getServer())
        .get('/api/v1/listings')
        .query({ cursor })
        .set('Cookie', applicantCookies)
        .expect(400);
    });

    it('returns 400 for a cursor with extra fields', async () => {
      const applicantCookies = await registerAndGetCookies(applicantPayload());
      const cursor = Buffer.from(
        JSON.stringify({
          publishedAt: new Date().toISOString(),
          id: '00000000-0000-4000-8000-000000000001',
          extra: true,
        }),
      ).toString('base64url');

      await request(getServer())
        .get('/api/v1/listings')
        .query({ cursor })
        .set('Cookie', applicantCookies)
        .expect(400);
    });
  });

  describe('publishedAt is null exclusion', () => {
    it('does not return PUBLISHED listings without publishedAt', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      await createPublishedListing(providerId, {
        title: 'Good',
        publishedAt: new Date(),
      });
      await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.PUBLISHED,
          city: 'Berlin',
          title: 'NoPublishedAt',
          publishedAt: null,
          objectType: ObjectType.APARTMENT,
        },
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      const res = await request(getServer())
        .get('/api/v1/listings')
        .set('Cookie', applicantCookies)
        .expect(200);

      const body = responseBody(res);
      const items = body.items as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Good');
    });

    it('returns 404 for a PUBLISHED detail without publishedAt', async () => {
      const providerCookies = await registerAndGetCookies(providerPayload());
      const meRes = await request(getServer())
        .get('/api/v1/auth/me')
        .set('Cookie', providerCookies)
        .expect(200);
      const providerId = responseBody(meRes).id as string;

      const noPublishedAt = await getPrisma().listing.create({
        data: {
          providerId,
          status: ListingStatus.PUBLISHED,
          city: 'Berlin',
          title: 'NoPublishedAt',
          publishedAt: null,
          objectType: ObjectType.APARTMENT,
        },
      });

      const applicantCookies = await registerAndGetCookies(applicantPayload());

      await request(getServer())
        .get(`/api/v1/listings/${noPublishedAt.id}`)
        .set('Cookie', applicantCookies)
        .expect(404);
    });
  });
});
