import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import { ListingStatus } from '../src/generated/prisma/enums';
import { ApplicationsService } from '../src/applications/applications.service';
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
    await agent.get('/api/v1/auth/me').expect(403);
  });

  it('checks eligibility from the applicant profile and enforces it on apply', async () => {
    const applicantAgent = request.agent(getServer());
    const applicantResponse = await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload())
      .expect(201);
    const applicant = safeUserBody(applicantResponse);

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
});
