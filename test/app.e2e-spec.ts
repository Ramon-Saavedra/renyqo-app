import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import type { UploadApiResponse } from 'cloudinary';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import {
  ApplicationStatus,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { ApplicationsService } from '../src/applications/applications.service';
import { CloudinaryService } from '../src/listing-images/cloudinary.service';
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
  providerType?: 'private' | 'company';
  companyName?: string;
};

type SafeUserBody = {
  id: string;
  name: string;
  email: string;
  role: 'APPLICANT' | 'PROVIDER' | 'ADMIN';
  providerType: 'private' | 'company' | null;
  companyName: string | null;
  emailVerified: boolean;
  status: string;
};

type ApplicationBody = {
  id: string;
  listingId: string;
  status: string;
};

type ListingImageItemBody = {
  id: string;
  secureUrl: string;
  position: number;
  isCover: boolean;
};

class CloudinaryServiceStub {
  readonly deletedPublicIds: string[] = [];

  uploadBuffer(): Promise<UploadApiResponse> {
    return Promise.reject(
      new Error('Cloudinary uploads are not available in E2E tests.'),
    );
  }

  deleteByPublicId(publicId: string): Promise<void> {
    this.deletedPublicIds.push(publicId);
    return Promise.resolve();
  }
}

const sessionSecret = 'e2e-session-secret-at-least-thirty-two-characters';
const userPassword = 'StrongPass123';

let app: INestApplication | undefined;
let prisma: PrismaService | undefined;
let sessionStore: PgSessionStore | undefined;
let cloudinaryStub: CloudinaryServiceStub | undefined;
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

function isSafeUserBody(value: unknown): value is SafeUserBody {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    (value.role === 'APPLICANT' ||
      value.role === 'PROVIDER' ||
      value.role === 'ADMIN') &&
    (value.providerType === null ||
      value.providerType === 'private' ||
      value.providerType === 'company') &&
    (value.companyName === null || typeof value.companyName === 'string') &&
    typeof value.emailVerified === 'boolean' &&
    typeof value.status === 'string'
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

function getApplicationsService(): ApplicationsService {
  if (!app) {
    throw new Error('E2E app has not been initialized.');
  }

  return app.get(ApplicationsService);
}

function getCloudinaryStub(): CloudinaryServiceStub {
  if (!cloudinaryStub) {
    throw new Error('Cloudinary stub has not been initialized.');
  }

  return cloudinaryStub;
}

async function seedListingImages(listingId: string, count: number) {
  const images = [];
  for (let index = 0; index < count; index += 1) {
    images.push(
      await getPrisma().listingImage.create({
        data: {
          listingId,
          publicId: `e2e/listings/${listingId}/img-${index}`,
          secureUrl: `https://res.cloudinary.com/e2e/image/upload/${listingId}-${index}.jpg`,
          position: index,
          isCover: index === 0,
        },
      }),
    );
  }

  await getPrisma().listing.update({
    where: { id: listingId },
    data: { photos: images.map((image) => image.secureUrl) },
  });

  return images;
}

function isListingImageItemBody(value: unknown): value is ListingImageItemBody {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.secureUrl === 'string' &&
    typeof value.position === 'number' &&
    typeof value.isCover === 'boolean'
  );
}

function listingImageBodies(response: Response): ListingImageItemBody[] {
  const body: unknown = response.body;
  if (!Array.isArray(body) || !body.every(isListingImageItemBody)) {
    throw new Error('E2E response does not contain listing image records.');
  }

  return body;
}

async function createPublishedListing(providerId: string) {
  return getPrisma().listing.create({
    data: {
      providerId,
      status: ListingStatus.PUBLISHED,
      city: 'Berlin',
      title: 'E2E Listing',
    },
  });
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

function safeUserBody(response: Response): SafeUserBody {
  const body = responseBody(response);
  if (!isSafeUserBody(body)) {
    throw new Error('E2E response does not contain a safe user.');
  }

  return body;
}

function responseBody(response: Response): Record<string, unknown> {
  const body: unknown = response.body;
  if (!isRecord(body)) {
    throw new Error('E2E response body is not an object.');
  }

  return body;
}

function isApplicationBody(value: unknown): value is ApplicationBody {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.listingId === 'string' &&
    typeof value.status === 'string'
  );
}

function applicationBodies(response: Response): ApplicationBody[] {
  const body: unknown = response.body;
  if (!Array.isArray(body) || !body.every(isApplicationBody)) {
    throw new Error('E2E response does not contain application records.');
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

describe('Backend API E2E', () => {
  beforeAll(async () => {
    useE2eEnvironment();

    cloudinaryStub = new CloudinaryServiceStub();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CloudinaryService)
      .useValue(cloudinaryStub)
      .compile();

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
        secret: config.getOrThrow<string>('SESSION_SECRET'),
        resave: false,
        saveUninitialized: false,
        name: 'sid',
        cookie: {
          httpOnly: true,
          secure: false,
          sameSite: 'lax',
        },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());

    await app.init();
    prisma = app.get(PrismaService);
    await clearDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    getCloudinaryStub().deletedPublicIds.length = 0;
  });

  afterAll(async () => {
    if (prisma) {
      await clearDatabase();
    }

    if (app) {
      await app.close();
    }

    if (sessionStore) {
      await Promise.resolve(sessionStore.close());
    }
  });

  it('returns health status', async () => {
    const response = await request(getServer())
      .get('/api/v1/health')
      .expect(200);

    const body = responseBody(response);
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body['timestamp']).toBe('string');
  });

  it('registers an applicant and returns the current user without sensitive fields', async () => {
    const agent = request.agent(getServer());
    const payload = applicantPayload();

    const registerResponse = await agent
      .post('/api/v1/auth/register')
      .send(payload)
      .expect(201);

    const registeredUser = safeUserBody(registerResponse);
    expect(registeredUser.email).toBe(payload.email);
    expect(registeredUser.role).toBe('APPLICANT');
    expect(responseBody(registerResponse)).not.toHaveProperty('passwordHash');
    expectSessionCookie(registerResponse);

    const meResponse = await agent.get('/api/v1/auth/me').expect(200);
    const currentUser = safeUserBody(meResponse);
    expect(currentUser.id).toBe(registeredUser.id);
    expect(currentUser.email).toBe(payload.email);
    expect(responseBody(meResponse)).not.toHaveProperty('passwordHash');
  });

  it('registers a private provider', async () => {
    const payload = providerPayload();

    const response = await request(getServer())
      .post('/api/v1/auth/register')
      .send(payload)
      .expect(201);

    const user = safeUserBody(response);
    expect(user.email).toBe(payload.email);
    expect(user.role).toBe('PROVIDER');
    expect(user.providerType).toBe('private');
    expect(user.companyName).toBeNull();
    expect(responseBody(response)).not.toHaveProperty('passwordHash');
  });

  it('rejects public admin registration', async () => {
    const payload = {
      ...applicantPayload(),
      role: 'admin',
    };

    await request(getServer())
      .post('/api/v1/auth/register')
      .send(payload)
      .expect(400);
  });

  it('rejects duplicate email registration', async () => {
    const email = uniqueEmail('duplicate');

    await request(getServer())
      .post('/api/v1/auth/register')
      .send(applicantPayload(email))
      .expect(201);

    await request(getServer())
      .post('/api/v1/auth/register')
      .send(applicantPayload(email))
      .expect(409);
  });

  it('logs in and returns the current user', async () => {
    const email = uniqueEmail('login');
    const agent = request.agent(getServer());

    await request(getServer())
      .post('/api/v1/auth/register')
      .send(applicantPayload(email))
      .expect(201);

    const loginResponse = await agent
      .post('/api/v1/auth/login')
      .send({ email, password: userPassword })
      .expect(200);

    const user = safeUserBody(loginResponse);
    expect(user.email).toBe(email);
    expect(user.role).toBe('APPLICANT');
    expect(responseBody(loginResponse)).not.toHaveProperty('passwordHash');
    expectSessionCookie(loginResponse);

    const meResponse = await agent.get('/api/v1/auth/me').expect(200);
    expect(safeUserBody(meResponse).email).toBe(email);
  });

  it('logs out an authenticated user', async () => {
    const agent = request.agent(getServer());

    await agent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);

    await agent.post('/api/v1/auth/logout').expect(200);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('returns the Applicant onboarding step from the authenticated HTTP route', async () => {
    await request(getServer()).get('/api/v1/me/onboarding-state').expect(401);

    const applicantAgent = request.agent(getServer());
    await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);

    await applicantAgent
      .get('/api/v1/me/onboarding-state')
      .expect(200)
      .expect((response: Response) => {
        expect(responseBody(response)).toEqual({
          role: 'applicant',
          nextStep: 'browse_listings',
        });
      });

    await applicantAgent
      .patch('/api/v1/applicant/profile')
      .send({ householdNetIncome: 2500 })
      .expect(200);

    await applicantAgent
      .get('/api/v1/me/onboarding-state')
      .expect(200)
      .expect((response: Response) => {
        expect(responseBody(response)).toEqual({
          role: 'applicant',
          nextStep: 'browse_listings',
        });
      });

    const providerAgent = request.agent(getServer());
    await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    await providerAgent
      .get('/api/v1/me/onboarding-state')
      .expect(200)
      .expect((response: Response) => {
        expect(responseBody(response)['nextStep']).toBe('create_first_listing');
      });
  });

  it('checks eligibility from the applicant profile and enforces it on apply', async () => {
    const applicantAgent = request.agent(getServer());
    const applicantResponse = await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);
    const applicant = safeUserBody(applicantResponse);

    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const provider = safeUserBody(providerResponse);
    const listing = await getPrisma().listing.create({
      data: {
        providerId: provider.id,
        status: ListingStatus.PUBLISHED,
        city: 'Berlin',
        title: 'Eligibility E2E Listing',
        minimumHouseholdNetIncome: 3000,
        schufaRequired: true,
      },
    });

    await getPrisma().applicantProfile.create({
      data: {
        applicantId: applicant.id,
        householdNetIncome: 2500,
        schufaAvailable: false,
      },
    });

    await applicantAgent.post('/api/v1/listings/not-a-uuid/apply').expect(400);
    await request(getServer())
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(401);
    await request(getServer())
      .get(`/api/v1/listings/${listing.id}/eligibility`)
      .expect(401);
    await providerAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(403);
    await providerAgent
      .get(`/api/v1/listings/${listing.id}/eligibility`)
      .expect(403);

    await applicantAgent
      .post(`/api/v1/listings/${listing.id}/check-eligibility`)
      .expect(404);

    const applicationsBeforeEligibilityCheck =
      await getPrisma().application.count();
    const profileBeforeEligibilityCheck =
      await getPrisma().applicantProfile.findUniqueOrThrow({
        where: { applicantId: applicant.id },
      });

    const blockedResponse = await applicantAgent
      .get(`/api/v1/listings/${listing.id}/eligibility`)
      .expect(200);
    expect(blockedResponse.body).toMatchObject({
      canApply: false,
      reasons: [
        'household_income_below_requirement',
        'schufa_required_but_not_available',
      ],
      warnings: [],
    });
    expect(typeof responseBody(blockedResponse)['evaluatedAt']).toBe('string');

    expect(await getPrisma().application.count()).toBe(
      applicationsBeforeEligibilityCheck,
    );
    expect(
      await getPrisma().applicantProfile.findUniqueOrThrow({
        where: { applicantId: applicant.id },
      }),
    ).toEqual(profileBeforeEligibilityCheck);

    await applicantAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(422);

    await getPrisma().applicantProfile.update({
      where: { applicantId: applicant.id },
      data: { householdNetIncome: 3500, schufaAvailable: true },
    });

    const allowedResponse = await applicantAgent
      .get(`/api/v1/listings/${listing.id}/eligibility`)
      .expect(200);
    expect(allowedResponse.body).toMatchObject({
      canApply: true,
      reasons: [],
      warnings: [],
    });
    expect(typeof responseBody(allowedResponse)['evaluatedAt']).toBe('string');
    await applicantAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(201);
    await applicantAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(409);

    const secondListing = await getPrisma().listing.create({
      data: {
        providerId: provider.id,
        status: ListingStatus.PUBLISHED,
        city: 'Berlin',
        title: 'Eligibility Recalculation Listing',
        minimumHouseholdNetIncome: 3000,
      },
    });

    await applicantAgent
      .get(`/api/v1/listings/${secondListing.id}/eligibility`)
      .expect(200)
      .expect((response: Response) => {
        expect(responseBody(response)['canApply']).toBe(true);
      });

    await getPrisma().listing.update({
      where: { id: secondListing.id },
      data: { minimumHouseholdNetIncome: 9000 },
    });

    await applicantAgent
      .post(`/api/v1/listings/${secondListing.id}/apply`)
      .expect(422);
    expect(
      await getPrisma().application.count({
        where: { listingId: secondListing.id },
      }),
    ).toBe(0);
  });

  it('returns a safe listing summary for applicant applications', async () => {
    const applicantAgent = request.agent(getServer());
    const applicantResponse = await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);
    safeUserBody(applicantResponse);

    const providerResponse = await request(getServer())
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const provider = safeUserBody(providerResponse);
    const listing = await getPrisma().listing.create({
      data: {
        providerId: provider.id,
        status: ListingStatus.PUBLISHED,
        city: 'Berlin',
        street: 'Private Street 1',
        title: 'Applicant Summary Listing',
        coldRent: 1200,
      },
    });
    await getPrisma().listingImage.create({
      data: {
        listingId: listing.id,
        publicId: `e2e/applications/${listing.id}/cover`,
        secureUrl: 'https://example.com/cover.jpg',
        position: 0,
        isCover: true,
      },
    });

    await applicantAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(201);

    const response = await applicantAgent
      .get('/api/v1/applicant/applications')
      .expect(200);
    const responseValue: unknown = response.body;
    if (
      !Array.isArray(responseValue) ||
      responseValue.length !== 1 ||
      !isRecord(responseValue[0]) ||
      !isRecord(responseValue[0].listing)
    ) {
      throw new Error('E2E applications response has an unexpected shape.');
    }
    const body = responseValue[0];
    const listingBody = responseValue[0].listing;
    expect(body).toMatchObject({
      listingId: listing.id,
      status: 'ACTIVE',
      listing: {
        title: 'Applicant Summary Listing',
        city: 'Berlin',
        coldRent: 1200,
        imageUrl: 'https://example.com/cover.jpg',
      },
    });
    expect(body).not.toHaveProperty('applicantId');
    expect(body).not.toHaveProperty('queueOrder');
    expect(listingBody).not.toHaveProperty('providerId');
    expect(listingBody).not.toHaveProperty('street');
    expect(listingBody).not.toHaveProperty('minimumHouseholdNetIncome');
  });

  it('protects applicant application routes and validates withdrawal ids', async () => {
    await request(getServer())
      .get('/api/v1/applicant/applications')
      .expect(401);

    const applicantAgent = request.agent(getServer());
    await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);

    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const listing = await createPublishedListing(
      safeUserBody(providerResponse).id,
    );

    const applicationResponse = await applicantAgent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(201);
    const applicationId = responseBody(applicationResponse)['id'];
    if (typeof applicationId !== 'string') {
      throw new Error('Application response did not include an id.');
    }

    await providerAgent.get('/api/v1/applicant/applications').expect(403);
    await providerAgent
      .delete(`/api/v1/applicant/applications/${applicationId}`)
      .expect(403);
    await applicantAgent
      .delete('/api/v1/applicant/applications/not-a-uuid')
      .expect(400);

    await getPrisma().application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED },
    });
    await applicantAgent
      .delete(`/api/v1/applicant/applications/${applicationId}`)
      .expect(409)
      .expect((response: Response) => {
        expect(responseBody(response)['message']).toBe(
          'This application cannot be withdrawn',
        );
      });
    expect(
      await getPrisma().application.findUniqueOrThrow({
        where: { id: applicationId },
      }),
    ).toMatchObject({ status: ApplicationStatus.REJECTED });
  });

  it('allows an applicant to withdraw and promotes the oldest eligible waiting application', async () => {
    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const listing = await createPublishedListing(
      safeUserBody(providerResponse).id,
    );
    const agents = Array.from({ length: 7 }, () => request.agent(getServer()));

    await Promise.all(
      agents.map((agent) =>
        agent
          .post('/api/v1/auth/register')
          .send(applicantPayload())
          .expect(201),
      ),
    );

    const applications = [] as Array<{
      agent: ReturnType<typeof request.agent>;
      id: string;
      status: string;
    }>;
    for (const agent of agents.slice(0, 6)) {
      const response = await agent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const body = responseBody(response);
      if (typeof body.id !== 'string' || typeof body.status !== 'string') {
        throw new Error('E2E application response has an unexpected shape.');
      }
      applications.push({ agent, id: body.id, status: body.status });
    }

    expect(
      applications
        .slice(0, 5)
        .every((application) => application.status === 'ACTIVE'),
    ).toBe(true);
    expect(applications[5].status).toBe('WAITING');

    const withdrawalResponse = await applications[0].agent
      .delete(`/api/v1/applicant/applications/${applications[0].id}`)
      .expect(200);
    expect(responseBody(withdrawalResponse)).toMatchObject({
      id: applications[0].id,
      listingId: listing.id,
      status: 'WITHDRAWN',
    });

    const promotedApplicationsResponse = await applications[5].agent
      .get('/api/v1/applicant/applications')
      .expect(200);
    const promotedApplications: unknown = promotedApplicationsResponse.body;
    if (
      !Array.isArray(promotedApplications) ||
      !isRecord(promotedApplications[0])
    ) {
      throw new Error(
        'E2E applicant applications response has an unexpected shape.',
      );
    }
    expect(promotedApplications[0].status).toBe('ACTIVE');

    await applications[0].agent
      .delete(`/api/v1/applicant/applications/${applications[0].id}`)
      .expect(200)
      .expect((response: Response) => {
        expect(responseBody(response)['status']).toBe('WITHDRAWN');
      });

    await agents[6]
      .delete(`/api/v1/applicant/applications/${applications[0].id}`)
      .expect(404);
  });

  it('enforces the five active application limit under concurrent requests', async () => {
    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const listing = await createPublishedListing(
      safeUserBody(providerResponse).id,
    );
    const agents = Array.from({ length: 8 }, () => request.agent(getServer()));

    await Promise.all(
      agents.map((agent) =>
        agent
          .post('/api/v1/auth/register')
          .send(applicantPayload())
          .expect(201),
      ),
    );

    const responses = await Promise.all(
      agents.map((agent) => agent.post(`/api/v1/listings/${listing.id}/apply`)),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const statuses = responses.map(
      (response) => responseBody(response)['status'],
    );

    expect(statuses.filter((status) => status === 'ACTIVE')).toHaveLength(5);
    expect(statuses.filter((status) => status === 'WAITING')).toHaveLength(3);

    const persisted = await getPrisma().application.findMany({
      where: { listingId: listing.id },
      select: { status: true },
    });
    expect(persisted).toHaveLength(8);
    expect(
      persisted.filter((application) => application.status === 'ACTIVE'),
    ).toHaveLength(5);
    expect(
      persisted.filter((application) => application.status === 'WAITING'),
    ).toHaveLength(3);

    const waitingApplications = await getPrisma().application.findMany({
      where: { listingId: listing.id, status: 'WAITING' },
      orderBy: { queueOrder: 'asc' },
      select: { id: true, applicantId: true, queueOrder: true },
    });
    expect(waitingApplications).toHaveLength(3);
    const providerApplications = await providerAgent
      .get('/api/v1/provider/listings/' + listing.id + '/applications')
      .expect(200);
    const providerApplicationBodies = applicationBodies(providerApplications);
    expect(providerApplicationBodies).toHaveLength(5);
    expect(
      providerApplicationBodies.some(
        (application) =>
          application.id === waitingApplications[0].id ||
          application.id === waitingApplications[1].id ||
          application.id === waitingApplications[2].id,
      ),
    ).toBe(false);
    await providerAgent
      .get('/api/v1/provider/listings/' + listing.id + '/waiting-count')
      .expect(200)
      .expect({ waitingCount: 3 });

    await getPrisma().listing.update({
      where: { id: listing.id },
      data: { minimumHouseholdNetIncome: 3000 },
    });
    await getPrisma().applicantProfile.createMany({
      data: [
        {
          applicantId: waitingApplications[0].applicantId,
          householdNetIncome: 1000,
        },
        {
          applicantId: waitingApplications[1].applicantId,
          householdNetIncome: 4000,
        },
        {
          applicantId: waitingApplications[2].applicantId,
          householdNetIncome: 4000,
        },
      ],
    });

    const activeApplication = await getPrisma().application.findFirstOrThrow({
      where: { listingId: listing.id, status: 'ACTIVE' },
      select: { id: true },
    });
    await getPrisma().application.update({
      where: { id: activeApplication.id },
      data: { status: 'REJECTED' },
    });

    await providerAgent
      .post('/api/v1/provider/listings/' + listing.id + '/promote-waiting')
      .expect(404);

    const promotionResults = await Promise.all([
      getApplicationsService().promoteWaitingApplications(listing.id),
      getApplicationsService().promoteWaitingApplications(listing.id),
    ]);
    expect(promotionResults).toEqual(expect.arrayContaining([0, 1]));

    const promotedWaitingApplication =
      await getPrisma().application.findUniqueOrThrow({
        where: { id: waitingApplications[1].id },
        select: { status: true },
      });
    const ineligibleWaitingApplication =
      await getPrisma().application.findUniqueOrThrow({
        where: { id: waitingApplications[0].id },
        select: { status: true },
      });
    expect(promotedWaitingApplication.status).toBe('ACTIVE');
    expect(ineligibleWaitingApplication.status).toBe('WAITING');
    const laterWaitingApplication =
      await getPrisma().application.findUniqueOrThrow({
        where: { id: waitingApplications[2].id },
        select: { status: true },
      });
    expect(laterWaitingApplication.status).toBe('WAITING');
    expect(
      await getPrisma().application.count({
        where: { listingId: listing.id, status: 'ACTIVE' },
      }),
    ).toBe(5);
    expect(
      await getPrisma().application.count({
        where: { listingId: listing.id, status: 'WAITING' },
      }),
    ).toBe(2);

    const providerApplicationsAfterPromotion = await providerAgent
      .get('/api/v1/provider/listings/' + listing.id + '/applications')
      .expect(200);
    const providerApplicationBodiesAfterPromotion = applicationBodies(
      providerApplicationsAfterPromotion,
    );
    const promotedApplicationBody =
      providerApplicationBodiesAfterPromotion.find(
        (application) => application.id === waitingApplications[1].id,
      );
    expect(promotedApplicationBody).toMatchObject({ status: 'ACTIVE' });
    expect(
      providerApplicationBodiesAfterPromotion.some(
        (application) => application.id === waitingApplications[0].id,
      ),
    ).toBe(false);
    await providerAgent
      .get('/api/v1/provider/listings/' + listing.id + '/waiting-count')
      .expect(200)
      .expect({ waitingCount: 2 });

    const otherProviderAgent = request.agent(getServer());
    const otherProviderResponse = await otherProviderAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const otherListing = await createPublishedListing(
      safeUserBody(otherProviderResponse).id,
    );
    await agents[0]
      .post(`/api/v1/listings/${otherListing.id}/apply`)
      .expect(201);
    const providerApplicationsAcrossListings = await providerAgent
      .get('/api/v1/provider/applications')
      .expect(200);
    const providerApplicationBodiesAcrossListings = applicationBodies(
      providerApplicationsAcrossListings,
    );
    expect(
      providerApplicationBodiesAcrossListings.every(
        (application) => application.listingId !== otherListing.id,
      ),
    ).toBe(true);
    const otherProviderApplications = await otherProviderAgent
      .get('/api/v1/provider/applications')
      .expect(200);
    expect(applicationBodies(otherProviderApplications)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ listingId: otherListing.id }),
      ]),
    );
    await otherProviderAgent
      .get('/api/v1/provider/listings/' + listing.id + '/applications')
      .expect(404);
    await otherProviderAgent
      .get('/api/v1/provider/listings/' + listing.id + '/waiting-count')
      .expect(404);
    await otherProviderAgent
      .post('/api/v1/provider/listings/' + listing.id + '/promote-waiting')
      .expect(404);

    const waitingCountResponse = await providerAgent
      .get('/api/v1/provider/listings/' + listing.id + '/waiting-count')
      .expect(200);
    expect(Object.keys(responseBody(waitingCountResponse))).toEqual([
      'waitingCount',
    ]);
  });

  it('manages listing images with ownership checks, delete compaction and reorder', async () => {
    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const provider = safeUserBody(providerResponse);

    const otherProviderAgent = request.agent(getServer());
    await otherProviderAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);

    const applicantAgent = request.agent(getServer());
    await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);

    const listing = await createPublishedListing(provider.id);
    const seeded = await seedListingImages(listing.id, 3);

    const listResponse = await providerAgent
      .get(`/api/v1/provider/listings/${listing.id}/images`)
      .expect(200);
    const listedImages = listingImageBodies(listResponse);
    expect(listedImages).toEqual([
      {
        id: seeded[0].id,
        secureUrl: seeded[0].secureUrl,
        position: 0,
        isCover: true,
      },
      {
        id: seeded[1].id,
        secureUrl: seeded[1].secureUrl,
        position: 1,
        isCover: false,
      },
      {
        id: seeded[2].id,
        secureUrl: seeded[2].secureUrl,
        position: 2,
        isCover: false,
      },
    ]);

    const detailResponse = await providerAgent
      .get(`/api/v1/provider/listings/${listing.id}`)
      .expect(200);
    expect(responseBody(detailResponse)['images']).toEqual(listedImages);

    await request(getServer())
      .get(`/api/v1/provider/listings/${listing.id}/images`)
      .expect(401);
    await applicantAgent
      .get(`/api/v1/provider/listings/${listing.id}/images`)
      .expect(403);
    await otherProviderAgent
      .get(`/api/v1/provider/listings/${listing.id}/images`)
      .expect(404);
    await otherProviderAgent
      .delete(`/api/v1/provider/listings/${listing.id}/images/${seeded[0].id}`)
      .expect(404);
    await otherProviderAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [seeded[2].id, seeded[1].id, seeded[0].id] })
      .expect(404);
    expect(getCloudinaryStub().deletedPublicIds).toHaveLength(0);

    await providerAgent
      .delete(`/api/v1/provider/listings/${listing.id}/images/${seeded[0].id}`)
      .expect(204);

    expect(getCloudinaryStub().deletedPublicIds).toEqual([seeded[0].publicId]);

    const afterDelete = await getPrisma().listingImage.findMany({
      where: { listingId: listing.id },
      orderBy: { position: 'asc' },
    });
    expect(afterDelete).toHaveLength(2);
    expect(afterDelete[0]).toMatchObject({
      id: seeded[1].id,
      position: 0,
      isCover: true,
    });
    expect(afterDelete[1]).toMatchObject({
      id: seeded[2].id,
      position: 1,
      isCover: false,
    });

    const listingAfterDelete = await getPrisma().listing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(listingAfterDelete.photos).toEqual([
      seeded[1].secureUrl,
      seeded[2].secureUrl,
    ]);

    await providerAgent
      .delete(`/api/v1/provider/listings/${listing.id}/images/${seeded[0].id}`)
      .expect(404);

    const reorderResponse = await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [seeded[2].id, seeded[1].id] })
      .expect(200);
    expect(listingImageBodies(reorderResponse)).toEqual([
      {
        id: seeded[2].id,
        secureUrl: seeded[2].secureUrl,
        position: 0,
        isCover: true,
      },
      {
        id: seeded[1].id,
        secureUrl: seeded[1].secureUrl,
        position: 1,
        isCover: false,
      },
    ]);

    const listingAfterReorder = await getPrisma().listing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(listingAfterReorder.photos).toEqual([
      seeded[2].secureUrl,
      seeded[1].secureUrl,
    ]);
    expect(
      await getPrisma().listingImage.count({
        where: { listingId: listing.id, isCover: true },
      }),
    ).toBe(1);
  });

  it('rejects invalid image sets on reorder without changing the stored order', async () => {
    const providerAgent = request.agent(getServer());
    const providerResponse = await providerAgent
      .post('/api/v1/auth/register')
      .send(providerPayload())
      .expect(201);
    const provider = safeUserBody(providerResponse);

    const listing = await createPublishedListing(provider.id);
    const otherListing = await createPublishedListing(provider.id);
    const seeded = await seedListingImages(listing.id, 2);
    const foreign = await seedListingImages(otherListing.id, 1);

    await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [seeded[0].id, seeded[0].id] })
      .expect(400);
    await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [seeded[1].id] })
      .expect(400);
    await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [seeded[0].id, foreign[0].id] })
      .expect(400);
    await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: [] })
      .expect(400);
    await providerAgent
      .patch(`/api/v1/provider/listings/${listing.id}/images/order`)
      .send({ imageIds: ['not-a-uuid', seeded[0].id] })
      .expect(400);

    const unchanged = await getPrisma().listingImage.findMany({
      where: { listingId: listing.id },
      orderBy: { position: 'asc' },
    });
    expect(unchanged.map((image) => image.id)).toEqual([
      seeded[0].id,
      seeded[1].id,
    ]);
    expect(unchanged[0]).toMatchObject({ position: 0, isCover: true });
    expect(unchanged[1]).toMatchObject({ position: 1, isCover: false });

    const unchangedListing = await getPrisma().listing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(unchangedListing.photos).toEqual([
      seeded[0].secureUrl,
      seeded[1].secureUrl,
    ]);
  });

  describe('applicant profile HTTP contract', () => {
    it('creates and reads a profile through HTTP', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent.get('/api/v1/applicant/profile').expect(404);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 3000, hasPets: false })
        .expect(200);

      const getResponse = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);

      const body = responseBody(getResponse);
      expect(body).toMatchObject({
        householdNetIncome: 3000,
        hasPets: false,
      });
    });

    it('returns only business fields, not internal fields', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 3000 })
        .expect(200);

      const response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);

      const body = responseBody(response);
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('applicantId');
      expect(body).not.toHaveProperty('createdAt');
      expect(body).not.toHaveProperty('updatedAt');
    });

    it('calculates peopleCount from adultsCount and childrenCount', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ adultsCount: 2, childrenCount: 1 })
        .expect(200);

      const response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);

      const body = responseBody(response);
      expect(body.adultsCount).toBe(2);
      expect(body.childrenCount).toBe(1);
      expect(body.peopleCount).toBe(3);
    });

    it('rejects incomplete household counts', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ adultsCount: 2 })
        .expect(400);
    });

    it('rejects client-supplied peopleCount', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ peopleCount: 5 })
        .expect(400);
    });

    it('clears fields with explicit null', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 3000, adultsCount: 2, childrenCount: 1 })
        .expect(200);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({
          householdNetIncome: null,
          adultsCount: null,
          childrenCount: null,
        })
        .expect(200);

      const response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);

      const body = responseBody(response);
      expect(body.householdNetIncome).toBeNull();
      expect(body.adultsCount).toBeNull();
      expect(body.childrenCount).toBeNull();
      expect(body.peopleCount).toBeNull();
    });

    it('normalizes empty and whitespace petsNote strings to null', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ petsNote: '' })
        .expect(200);

      let response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);
      expect(responseBody(response).petsNote).toBeNull();

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ petsNote: '   ' })
        .expect(200);

      response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);
      expect(responseBody(response).petsNote).toBeNull();
    });

    it('preserves omitted fields on PATCH', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 3000, hasPets: true })
        .expect(200);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 4000 })
        .expect(200);

      const response = await applicantAgent
        .get('/api/v1/applicant/profile')
        .expect(200);

      const body = responseBody(response);
      expect(body.householdNetIncome).toBe(4000);
      expect(body.hasPets).toBe(true);
    });

    it('rejects empty PATCH body', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({})
        .expect(400);
    });

    it('updates eligibility from HTTP-updated profile', async () => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      const providerAgent = request.agent(getServer());
      const provider = safeUserBody(
        await providerAgent
          .post('/api/v1/auth/register')
          .send(providerPayload())
          .expect(201),
      );

      const listing = await getPrisma().listing.create({
        data: {
          providerId: provider.id,
          status: ListingStatus.PUBLISHED,
          city: 'Berlin',
          title: 'Eligibility E2E Listing',
          minimumHouseholdNetIncome: 3000,
        },
      });

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 2500 })
        .expect(200);

      const blocked = await applicantAgent
        .get(`/api/v1/listings/${listing.id}/eligibility`)
        .expect(200);
      expect(responseBody(blocked)['canApply']).toBe(false);

      await applicantAgent
        .patch('/api/v1/applicant/profile')
        .send({ householdNetIncome: 3500 })
        .expect(200);

      const allowed = await applicantAgent
        .get(`/api/v1/listings/${listing.id}/eligibility`)
        .expect(200);
      expect(responseBody(allowed)['canApply']).toBe(true);
    });
  });

  describe('unpublished listing rejection', () => {
    it.each([
      ListingStatus.DRAFT,
      ListingStatus.PAUSED,
      ListingStatus.ARCHIVED,
    ])('rejects applications to a listing with status %s', async (status) => {
      const applicantAgent = request.agent(getServer());
      await applicantAgent
        .post('/api/v1/auth/register')
        .send(applicantPayload())
        .expect(201);

      const providerAgent = request.agent(getServer());
      const provider = safeUserBody(
        await providerAgent
          .post('/api/v1/auth/register')
          .send(providerPayload())
          .expect(201),
      );

      const listing = await getPrisma().listing.create({
        data: {
          providerId: provider.id,
          status,
          city: 'Berlin',
          title: 'Unpublished Listing',
        },
      });

      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(422);

      const count = await getPrisma().application.count({
        where: { listingId: listing.id },
      });
      expect(count).toBe(0);
    });
  });

  describe('re-applying after withdrawal', () => {
    async function createApplicantAndListing() {
      const applicantAgent = request.agent(getServer());
      const applicant = safeUserBody(
        await applicantAgent
          .post('/api/v1/auth/register')
          .send(applicantPayload())
          .expect(201),
      );

      const providerAgent = request.agent(getServer());
      const provider = safeUserBody(
        await providerAgent
          .post('/api/v1/auth/register')
          .send(providerPayload())
          .expect(201),
      );

      const listing = await createPublishedListing(provider.id);
      return { applicantAgent, applicant, providerAgent, listing };
    }

    function applicationIdFromResponse(response: Response): string {
      const id = responseBody(response)['id'];
      if (typeof id !== 'string') {
        throw new Error('Application response did not include an id.');
      }
      return id;
    }

    it('creates a new application row and leaves the previous WITHDRAWN row unchanged', async () => {
      const { applicantAgent, listing } = await createApplicantAndListing();

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      const secondResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const secondApplicationId = applicationIdFromResponse(secondResponse);

      expect(secondApplicationId).not.toBe(firstApplicationId);
      expect(responseBody(secondResponse)['status']).toBe('ACTIVE');

      const applications = await getPrisma().application.findMany({
        where: { listingId: listing.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(applications).toHaveLength(2);
      expect(applications[0].id).toBe(firstApplicationId);
      expect(applications[0].status).toBe('WITHDRAWN');
      expect(applications[1].id).toBe(secondApplicationId);
      expect(applications[1].status).not.toBe('WITHDRAWN');
      expect(applications[1].queueOrder).toBeGreaterThan(
        applications[0].queueOrder,
      );
    });

    it('places a re-applied WAITING application behind existing waiting applications', async () => {
      const providerAgent = request.agent(getServer());
      const provider = safeUserBody(
        await providerAgent
          .post('/api/v1/auth/register')
          .send(providerPayload())
          .expect(201),
      );
      const listing = await createPublishedListing(provider.id);
      const agents = Array.from({ length: 7 }, () =>
        request.agent(getServer()),
      );

      await Promise.all(
        agents.map((agent) =>
          agent
            .post('/api/v1/auth/register')
            .send(applicantPayload())
            .expect(201),
        ),
      );

      const applications = [] as Array<{
        agent: ReturnType<typeof request.agent>;
        id: string;
        status: string;
      }>;
      for (const agent of agents) {
        const response = await agent
          .post(`/api/v1/listings/${listing.id}/apply`)
          .expect(201);
        const body = responseBody(response);
        if (typeof body.id !== 'string' || typeof body.status !== 'string') {
          throw new Error('E2E application response has an unexpected shape.');
        }
        applications.push({ agent, id: body.id, status: body.status });
      }

      expect(
        applications.slice(0, 5).every((app) => app.status === 'ACTIVE'),
      ).toBe(true);
      expect(applications[5].status).toBe('WAITING');
      expect(applications[6].status).toBe('WAITING');

      await applications[5].agent
        .delete(`/api/v1/applicant/applications/${applications[5].id}`)
        .expect(200);

      const reappliedResponse = await applications[5].agent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      expect(responseBody(reappliedResponse)['status']).toBe('WAITING');
      const reappliedId = applicationIdFromResponse(reappliedResponse);

      const waitingApplications = await getPrisma().application.findMany({
        where: { listingId: listing.id, status: 'WAITING' },
        orderBy: { queueOrder: 'asc' },
      });
      expect(waitingApplications).toHaveLength(2);
      expect(waitingApplications[0].id).toBe(applications[6].id);
      expect(waitingApplications[1].id).toBe(reappliedId);
      expect(waitingApplications[1].queueOrder).toBeGreaterThan(
        waitingApplications[0].queueOrder,
      );
    });

    it('prevents duplicate live applications after re-applying', async () => {
      const { applicantAgent, listing } = await createApplicantAndListing();

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(409);

      const liveApplications = await getPrisma().application.findMany({
        where: {
          listingId: listing.id,
          status: { in: ['ACTIVE', 'WAITING'] },
        },
      });
      expect(liveApplications).toHaveLength(1);
    });

    it('keeps only one live application under concurrent re-apply attempts', async () => {
      const { applicant, listing } = await createApplicantAndListing();

      const firstAgent = request.agent(getServer());
      await firstAgent
        .post('/api/v1/auth/login')
        .send({ email: applicant.email, password: userPassword })
        .expect(200);

      const firstResponse = await firstAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await firstAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      const secondAgent = request.agent(getServer());
      await secondAgent
        .post('/api/v1/auth/login')
        .send({ email: applicant.email, password: userPassword })
        .expect(200);

      const [responseA, responseB] = await Promise.all([
        firstAgent.post(`/api/v1/listings/${listing.id}/apply`),
        secondAgent.post(`/api/v1/listings/${listing.id}/apply`),
      ]);

      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const liveApplications = await getPrisma().application.findMany({
        where: {
          listingId: listing.id,
          status: { in: ['ACTIVE', 'WAITING'] },
        },
      });
      expect(liveApplications).toHaveLength(1);
    });

    it('rejects re-applying when the listing is no longer PUBLISHED', async () => {
      const { applicantAgent, providerAgent, listing } =
        await createApplicantAndListing();

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/archive`)
        .expect(200);

      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(422);

      const count = await getPrisma().application.count({
        where: { listingId: listing.id },
      });
      expect(count).toBe(1);
    });

    it('recalculates eligibility when re-applying', async () => {
      const { applicantAgent, applicant, listing } =
        await createApplicantAndListing();

      await getPrisma().listing.update({
        where: { id: listing.id },
        data: { minimumHouseholdNetIncome: 3000 },
      });
      await getPrisma().applicantProfile.create({
        data: {
          applicantId: applicant.id,
          householdNetIncome: 4000,
        },
      });

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      await getPrisma().applicantProfile.update({
        where: { applicantId: applicant.id },
        data: { householdNetIncome: 1000 },
      });

      const blockedResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(422);
      expect(responseBody(blockedResponse)).toMatchObject({
        canApply: false,
        reasons: ['household_income_below_requirement'],
      });

      const liveApplications = await getPrisma().application.findMany({
        where: {
          listingId: listing.id,
          status: { in: ['ACTIVE', 'WAITING'] },
        },
      });
      expect(liveApplications).toHaveLength(0);
    });

    it('supports a full withdraw -> reapply -> withdraw lifecycle', async () => {
      const { applicantAgent, listing } = await createApplicantAndListing();

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${firstApplicationId}`)
        .expect(200);

      const secondResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const secondApplicationId = applicationIdFromResponse(secondResponse);

      await applicantAgent
        .delete(`/api/v1/applicant/applications/${secondApplicationId}`)
        .expect(200);

      const applications = await getPrisma().application.findMany({
        where: { listingId: listing.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(applications).toHaveLength(2);
      expect(applications[0].id).toBe(firstApplicationId);
      expect(applications[0].status).toBe('WITHDRAWN');
      expect(applications[1].id).toBe(secondApplicationId);
      expect(applications[1].status).toBe('WITHDRAWN');
    });

    it('blocks re-applying after a provider rejection', async () => {
      const { applicantAgent, providerAgent, listing } =
        await createApplicantAndListing();

      const firstResponse = await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
      const firstApplicationId = applicationIdFromResponse(firstResponse);

      await providerAgent
        .patch(`/api/v1/provider/applications/${firstApplicationId}/reject`)
        .expect(200);

      await applicantAgent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(409);

      const applications = await getPrisma().application.findMany({
        where: { listingId: listing.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(applications).toHaveLength(1);
      expect(applications[0].id).toBe(firstApplicationId);
      expect(applications[0].status).toBe('REJECTED');
    });
  });
});
