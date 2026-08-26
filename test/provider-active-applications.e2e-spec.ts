import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import { ListingStatus, SmokingStatus } from '../src/generated/prisma/enums';
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
  role: string;
  providerType: 'private' | 'company' | null;
  companyName: string | null;
  emailVerified: boolean;
  status: string;
};

type ProviderActiveApplicationBody = {
  id: string;
  listingId: string;
  status: string;
  applicant: {
    name: string;
    peopleCount: number | null;
  };
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

function isSafeUserBody(value: unknown): value is SafeUserBody {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    typeof value.role === 'string' &&
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

function uniqueEmail(prefix: string): string {
  emailSequence += 1;
  return `${prefix}-${emailSequence}@e2e.renyqo.test`;
}

function applicantPayload(
  name: string,
  email = uniqueEmail('applicant'),
): RegisterPayload {
  return {
    name,
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

function isProviderActiveApplicationBody(
  value: unknown,
): value is ProviderActiveApplicationBody {
  if (!isRecord(value) || !isRecord(value.applicant)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.listingId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.applicant.name === 'string' &&
    (value.applicant.peopleCount === null ||
      typeof value.applicant.peopleCount === 'number') &&
    Object.keys(value).length === 4 &&
    Object.keys(value.applicant).length === 2
  );
}

function activeApplicationBodies(
  response: Response,
): ProviderActiveApplicationBody[] {
  const body: unknown = response.body;
  if (!Array.isArray(body) || !body.every(isProviderActiveApplicationBody)) {
    throw new Error(
      'E2E active-applications response has an unexpected shape.',
    );
  }

  return body;
}

async function registerProvider() {
  const agent = request.agent(getServer());
  const response = await agent
    .post('/api/v1/auth/register')
    .send(providerPayload())
    .expect(201);
  return { agent, provider: safeUserBody(response) };
}

async function registerApplicantWithProfile(options: {
  name: string;
  adultsCount: number;
  childrenCount: number;
  householdNetIncome: number;
  hasPets: boolean;
  petsNote: string | null;
  smokingStatus: SmokingStatus;
}) {
  const agent = request.agent(getServer());
  const email = uniqueEmail('applicant');
  const response = await agent
    .post('/api/v1/auth/register')
    .send(applicantPayload(options.name, email))
    .expect(201);
  const applicant = safeUserBody(response);

  await getPrisma().applicantProfile.create({
    data: {
      applicantId: applicant.id,
      adultsCount: options.adultsCount,
      childrenCount: options.childrenCount,
      peopleCount: options.adultsCount + options.childrenCount,
      householdNetIncome: options.householdNetIncome,
      incomeProofAvailable: true,
      schufaAvailable: true,
      hasPets: options.hasPets,
      petsNote: options.petsNote,
      smokingStatus: options.smokingStatus,
    },
  });

  return { agent, applicant };
}

async function publishListing(providerId: string) {
  return getPrisma().listing.create({
    data: {
      providerId,
      status: ListingStatus.PUBLISHED,
      publishedAt: new Date(),
      city: 'Berlin',
      street: 'Test Street 1',
      title: 'Provider Active Applications Listing',
      coldRent: 800,
      livingArea: 50,
      rooms: 2,
      bedrooms: 1,
      availableFrom: new Date(),
    },
  });
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

describe('Provider ACTIVE applications summary E2E', () => {
  beforeAll(async () => {
    useE2eEnvironment();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CloudinaryService)
      .useValue({
        uploadBuffer: () => Promise.reject(new Error('not available')),
        deleteByPublicId: () => Promise.resolve(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
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
        cookie: { httpOnly: true, secure: false, sameSite: 'lax' },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());

    prisma = app.get<PrismaService>(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  it('returns an empty list when a listing has no ACTIVE applications', async () => {
    const { agent, provider } = await registerProvider();
    const listing = await publishListing(provider.id);

    const response = await agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(200);

    expect(activeApplicationBodies(response)).toEqual([]);
    await agent
      .get(`/api/v1/provider/listings/${listing.id}/waiting-count`)
      .expect(200)
      .expect({ waitingCount: 0 });
  });

  it('returns minimal applicant summaries for 1–4 ACTIVE applications in createdAt ASC order', async () => {
    const { agent, provider } = await registerProvider();
    const listing = await publishListing(provider.id);

    const first = await registerApplicantWithProfile({
      name: 'First Applicant',
      adultsCount: 1,
      childrenCount: 0,
      householdNetIncome: 3000,
      hasPets: false,
      petsNote: null,
      smokingStatus: SmokingStatus.NON_SMOKER,
    });
    const second = await registerApplicantWithProfile({
      name: 'Second Applicant',
      adultsCount: 2,
      childrenCount: 1,
      householdNetIncome: 4500,
      hasPets: true,
      petsNote: 'One dog',
      smokingStatus: SmokingStatus.OCCASIONALLY,
    });

    await first.agent.post(`/api/v1/listings/${listing.id}/apply`).expect(201);
    await second.agent.post(`/api/v1/listings/${listing.id}/apply`).expect(201);

    const response = await agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(200);
    const bodies = activeApplicationBodies(response);

    expect(bodies).toHaveLength(2);
    expect(bodies.map((item) => item.applicant.name)).toEqual([
      'First Applicant',
      'Second Applicant',
    ]);
    expect(bodies[0]).toMatchObject({
      listingId: listing.id,
      status: 'ACTIVE',
      applicant: {
        name: 'First Applicant',
        peopleCount: 1,
      },
    });
    expect(bodies[1]).toMatchObject({
      applicant: {
        name: 'Second Applicant',
        peopleCount: 3,
      },
    });
    expect(Object.keys(bodies[0]).sort()).toEqual([
      'applicant',
      'id',
      'listingId',
      'status',
    ]);
    expect(Object.keys(bodies[0].applicant).sort()).toEqual([
      'name',
      'peopleCount',
    ]);

    await agent
      .get(`/api/v1/provider/listings/${listing.id}/waiting-count`)
      .expect(200)
      .expect({ waitingCount: 0 });
  });

  it('returns at most five ACTIVE summaries and never exposes WAITING applicant data', async () => {
    const { agent, provider } = await registerProvider();
    const listing = await publishListing(provider.id);
    const applicants: Array<
      Awaited<ReturnType<typeof registerApplicantWithProfile>>
    > = [];

    for (let index = 0; index < 7; index += 1) {
      applicants.push(
        await registerApplicantWithProfile({
          name: `Applicant ${index + 1}`,
          adultsCount: 1,
          childrenCount: 0,
          householdNetIncome: 3200 + index,
          hasPets: false,
          petsNote: null,
          smokingStatus: SmokingStatus.NON_SMOKER,
        }),
      );
    }

    for (const applicant of applicants) {
      await applicant.agent
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(201);
    }

    const waiting = await getPrisma().application.findMany({
      where: { listingId: listing.id, status: 'WAITING' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, applicantId: true },
    });
    expect(waiting).toHaveLength(2);

    const response = await agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(200);
    const bodies = activeApplicationBodies(response);

    expect(bodies).toHaveLength(5);
    expect(bodies.every((item) => item.status === 'ACTIVE')).toBe(true);
    expect(bodies.map((item) => item.applicant.name)).toEqual([
      'Applicant 1',
      'Applicant 2',
      'Applicant 3',
      'Applicant 4',
      'Applicant 5',
    ]);
    expect(
      bodies.some(
        (item) =>
          item.id === waiting[0].id ||
          item.id === waiting[1].id ||
          item.applicant.name === 'Applicant 6' ||
          item.applicant.name === 'Applicant 7',
      ),
    ).toBe(false);

    await agent
      .get(`/api/v1/provider/listings/${listing.id}/waiting-count`)
      .expect(200)
      .expect({ waitingCount: 2 });
  });

  it('returns a null household total when an ACTIVE applicant has no profile', async () => {
    const { agent, provider } = await registerProvider();
    const listing = await publishListing(provider.id);
    const applicantAgent = request.agent(getServer());
    const applicantResponse = await applicantAgent
      .post('/api/v1/auth/register')
      .send(applicantPayload('No Profile Applicant'))
      .expect(201);
    const applicant = safeUserBody(applicantResponse);

    await getPrisma().application.create({
      data: {
        listingId: listing.id,
        applicantId: applicant.id,
        status: 'ACTIVE',
      },
    });

    const response = await agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(200);

    const bodies = activeApplicationBodies(response);

    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]?.id).toBe('string');
    expect(bodies[0]).toMatchObject({
      listingId: listing.id,
      status: 'ACTIVE',
      applicant: { name: 'No Profile Applicant', peopleCount: null },
    });
  });

  it('rejects unauthenticated and non-provider access to ACTIVE applications', async () => {
    const { provider } = await registerProvider();
    const listing = await publishListing(provider.id);
    const applicant = await registerApplicantWithProfile({
      name: 'Gate Applicant',
      adultsCount: 1,
      childrenCount: 0,
      householdNetIncome: 3000,
      hasPets: false,
      petsNote: null,
      smokingStatus: SmokingStatus.NON_SMOKER,
    });

    await request(getServer())
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(401);
    await applicant.agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(403);
  });

  it('rejects access to ACTIVE applicants for a listing owned by another provider', async () => {
    const owner = await registerProvider();
    const other = await registerProvider();
    const listing = await publishListing(owner.provider.id);
    const applicant = await registerApplicantWithProfile({
      name: 'Owned Applicant',
      adultsCount: 1,
      childrenCount: 0,
      householdNetIncome: 3000,
      hasPets: false,
      petsNote: null,
      smokingStatus: SmokingStatus.NON_SMOKER,
    });

    await applicant.agent
      .post(`/api/v1/listings/${listing.id}/apply`)
      .expect(201);

    await other.agent
      .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
      .expect(404);
    await other.agent
      .get(`/api/v1/provider/listings/${listing.id}/waiting-count`)
      .expect(404);
  });
});
