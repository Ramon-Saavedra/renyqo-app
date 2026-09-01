import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
} from '../src/generated/prisma/enums';
import { CloudinaryService } from '../src/listing-images/cloudinary.service';
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

async function registerApplicant() {
  const agent = request.agent(getServer());
  await agent
    .post('/api/v1/auth/register')
    .send(applicantPayload())
    .expect(201);
  return agent;
}

async function registerProvider() {
  const agent = request.agent(getServer());
  const resp = await agent
    .post('/api/v1/auth/register')
    .send(providerPayload())
    .expect(201);
  return { agent, provider: safeUserBody(resp) };
}

async function publishListing(providerId: string) {
  const created = await getPrisma().listing.create({
    data: {
      providerId,
      status: ListingStatus.PUBLISHED,
      publishedAt: new Date(),
      city: 'Berlin',
      street: 'Test Street 1',
      title: 'E2E Test Listing',
      coldRent: 800,
      livingArea: 50,
      rooms: 2,
      bedrooms: 1,
      availableFrom: new Date(),
    },
  });
  return created;
}

async function applyToListing(
  agent: ReturnType<typeof request.agent>,
  listingId: string,
) {
  const resp = await agent
    .post(`/api/v1/listings/${listingId}/apply`)
    .expect(201);
  return responseBody(resp);
}

async function updateApplicantProfile(
  agent: ReturnType<typeof request.agent>,
  profile: {
    adultsCount?: number;
    childrenCount?: number;
    householdNetIncome?: number;
    incomeProofAvailable?: boolean;
    schufaAvailable?: boolean;
    hasPets?: boolean;
    isSmoker?: boolean;
  },
) {
  await agent.patch('/api/v1/applicant/profile').send(profile).expect(200);
}

async function publishListingWithRequirements(
  providerId: string,
  requirements: {
    suitableForPeopleCount?: number;
  },
) {
  return getPrisma().listing.create({
    data: {
      providerId,
      status: ListingStatus.PUBLISHED,
      publishedAt: new Date(),
      city: 'Berlin',
      street: 'Test Street 1',
      title: 'E2E Test Listing',
      coldRent: 800,
      livingArea: 50,
      rooms: 2,
      bedrooms: 1,
      availableFrom: new Date(),
      ...requirements,
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

describe('Application Lifecycle E2E', () => {
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

  afterEach(async () => {
    await clearDatabase();
  });

  describe('Provider rejects an application', () => {
    it('rejects an ACTIVE candidate with NOT_SELECTED and sets rejectedAt', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);
      const entryId = entry['id'] as string;

      await providerAgent
        .patch(`/api/v1/provider/applications/${entryId}/reject`)
        .send()
        .expect(200)
        .expect((res: Response) => {
          const body = responseBody(res);
          expect(body['status']).toBe('REJECTED');
          expect(body['publicReason']).toBe('NOT_SELECTED');
          expect(body['rejectedAt']).toBeTruthy();
        });

      const persisted = await getPrisma().application.findFirst({
        where: { listingId: listing.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(ApplicationStatus.REJECTED);
      expect(persisted!.publicReason).toBe(
        ApplicationRejectionReason.NOT_SELECTED,
      );
      expect(persisted!.rejectedAt).toBeInstanceOf(Date);
    });

    it('returns 404 when provider does not own the listing', async () => {
      const { agent: providerA } = await registerProvider();
      const { provider: providerB } = await registerProvider();
      const listing = await publishListing(providerB.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerA
        .patch(`/api/v1/provider/applications/${entry['id'] as string}/reject`)
        .send()
        .expect(404);
    });

    it('returns 404 for a non-existent candidate', async () => {
      const { agent: providerAgent } = await registerProvider();

      await providerAgent
        .patch(
          '/api/v1/provider/applications/00000000-0000-4000-8000-000000000099/reject',
        )
        .send()
        .expect(404);
    });

    it('returns 409 for REJECTED status', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerAgent
        .patch(`/api/v1/provider/applications/${String(entry['id'])}/reject`)
        .send()
        .expect(200);

      await providerAgent
        .patch(`/api/v1/provider/applications/${String(entry['id'])}/reject`)
        .send()
        .expect(409);
    });

    it('promotes the oldest WAITING candidate after rejecting ACTIVE', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 7 }, () => registerApplicant()),
      );
      const entries = await Promise.all(
        agents.map((a) => applyToListing(a, listing.id)),
      );

      const activeCount = entries.filter(
        (e) => e['status'] === ApplicationStatus.ACTIVE,
      ).length;
      const waitingCount = entries.filter(
        (e) => e['status'] === ApplicationStatus.WAITING,
      ).length;
      expect(activeCount).toBe(5);
      expect(waitingCount).toBe(2);

      const firstActiveId = entries.find(
        (e) => e['status'] === ApplicationStatus.ACTIVE,
      )!['id'] as string;

      await providerAgent
        .patch(`/api/v1/provider/applications/${firstActiveId}/reject`)
        .send()
        .expect(200);

      const dbEntries = await getPrisma().application.findMany({
        where: { listingId: listing.id },
      });
      const newActiveCount = dbEntries.filter(
        (e) => e.status === ApplicationStatus.ACTIVE,
      ).length;
      expect(newActiveCount).toBe(5);
    });
  });

  describe('Provider marks listing as rented', () => {
    it('rents a PUBLISHED listing and transitions all candidates', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 3 }, () => registerApplicant()),
      );
      const entries = await Promise.all(
        agents.map((a) => applyToListing(a, listing.id)),
      );

      const activeEntries = entries.filter(
        (e) => e['status'] === ApplicationStatus.ACTIVE,
      );
      const selectedId = activeEntries[0]['id'] as string;

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: selectedId })
        .expect(200)
        .expect((res: Response) => {
          const body = responseBody(res);
          expect(body['status']).toBe('RENTED');
          expect(body['rentedAt']).toBeTruthy();
        });

      const updatedListing = await getPrisma().listing.findUnique({
        where: { id: listing.id },
      });
      expect(updatedListing!.status).toBe(ListingStatus.RENTED);
      expect(updatedListing!.rentedAt).toBeInstanceOf(Date);

      const selectedEntry = await getPrisma().application.findUnique({
        where: { id: selectedId },
      });
      expect(selectedEntry!.status).toBe(ApplicationStatus.ACCEPTED);

      const remaining = await getPrisma().application.findMany({
        where: { listingId: listing.id, id: { not: selectedId } },
      });
      for (const r of remaining) {
        expect(r.status).toBe(ApplicationStatus.REJECTED);
        expect(r.publicReason).toBe(ApplicationRejectionReason.LISTING_RENTED);
        expect(r.rejectedAt).toBeInstanceOf(Date);
      }
    });

    it('rents a PAUSED listing', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await getPrisma().listing.update({
        where: { id: listing.id },
        data: { status: ListingStatus.PAUSED },
      });

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(200);

      const updated = await getPrisma().listing.findUnique({
        where: { id: listing.id },
      });
      expect(updated!.status).toBe(ListingStatus.RENTED);
    });

    it('returns 404 when provider does not own the listing', async () => {
      const { provider: providerA } = await registerProvider();
      const { agent: providerB } = await registerProvider();
      const listing = await publishListing(providerA.id);

      await providerB
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({
          selectedApplicationId: '00000000-0000-4000-8000-000000000099',
        })
        .expect(404);
    });

    it('returns 409 when selected candidate does not belong to the listing', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({
          selectedApplicationId: '00000000-0000-4000-8000-000000000099',
        })
        .expect(409);
    });

    it('returns 409 when selected candidate is not ACTIVE', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerAgent
        .patch(`/api/v1/provider/applications/${String(entry['id'])}/reject`)
        .send()
        .expect(200);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(409);
    });

    it('no WAITING candidate is promoted after RENTED', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 7 }, () => registerApplicant()),
      );
      const entries = await Promise.all(
        agents.map((a) => applyToListing(a, listing.id)),
      );

      const waitingBefore = entries.filter(
        (e) => e['status'] === ApplicationStatus.WAITING,
      );
      expect(waitingBefore.length).toBe(2);

      const activeEntryId = entries.find(
        (e) => e['status'] === ApplicationStatus.ACTIVE,
      )!['id'] as string;

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: activeEntryId })
        .expect(200);

      const dbEntries = await getPrisma().application.findMany({
        where: { listingId: listing.id },
      });
      const waitingAfter = dbEntries.filter(
        (e) => e.status === ApplicationStatus.WAITING,
      );
      expect(waitingAfter.length).toBe(0);

      const accepted = dbEntries.filter(
        (e) => e.status === ApplicationStatus.ACCEPTED,
      );
      expect(accepted.length).toBe(1);
      expect(accepted[0].id).toBe(activeEntryId);

      const rejected = dbEntries.filter(
        (e) => e.status === ApplicationStatus.REJECTED,
      );
      for (const r of rejected) {
        expect(r.publicReason).toBe(ApplicationRejectionReason.LISTING_RENTED);
      }
    });

    it('RENTED listing is excluded from applicant discovery', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(200);

      await applicantAgent.get(`/api/v1/listings/${listing.id}`).expect(404);

      await applicantAgent
        .get('/api/v1/listings')
        .expect(200)
        .expect((res: Response) => {
          const body = responseBody(res);
          const items = body['items'] as Array<{ id: string }>;
          expect(items.find((i) => i.id === listing.id)).toBeUndefined();
        });
    });

    it('RENTED listing rejects new candidates', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(200);

      const anotherApplicant = await registerApplicant();
      await anotherApplicant
        .post(`/api/v1/listings/${listing.id}/apply`)
        .expect(422);
    });

    it('returns 409 when listing is DRAFT', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await getPrisma().listing.create({
        data: {
          providerId: provider.id,
          status: ListingStatus.DRAFT,
          city: 'Berlin',
          title: 'Draft Listing',
        },
      });

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({
          selectedApplicationId: '00000000-0000-4000-8000-000000000099',
        })
        .expect(409);
    });

    it('returns 409 when listing is already RENTED', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();
      const entry = await applyToListing(applicantAgent, listing.id);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(200);

      await providerAgent
        .patch(`/api/v1/provider/listings/${listing.id}/rent`)
        .send({ selectedApplicationId: entry['id'] })
        .expect(409);
    });
  });

  describe('Applicant candidate response', () => {
    it('exposes only safe fields', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicantAgent = await registerApplicant();

      const entry = await applyToListing(applicantAgent, listing.id);
      await providerAgent
        .patch(`/api/v1/provider/applications/${String(entry['id'])}/reject`)
        .send()
        .expect(200);

      await applicantAgent
        .get('/api/v1/applicant/applications')
        .expect(200)
        .expect((res: Response) => {
          const items = res.body as Array<Record<string, unknown>>;
          expect(items.length).toBeGreaterThanOrEqual(1);
          const item = items[0];
          expect(item['id']).toBeTruthy();
          expect(item['listingId']).toBeTruthy();
          expect(item['status']).toBe('REJECTED');
          expect(item['createdAt']).toBeTruthy();
          expect(item['updatedAt']).toBeTruthy();
          expect(item['rejectedAt']).toBeTruthy();
          expect(item['publicReason']).toBe('NOT_SELECTED');
          expect(item['queueOrder']).toBeUndefined();
          expect(item['applicantId']).toBeUndefined();
          expect(item['providerId']).toBeUndefined();
          const listingData = item['listing'] as Record<string, unknown>;
          expect(listingData['title']).toBeTruthy();
          expect(listingData['city']).toBeTruthy();
          expect(listingData['coldRent']).toBeTruthy();
          expect(listingData['providerId']).toBeUndefined();
          expect(listingData['street']).toBeUndefined();
        });
    });
  });

  describe('Applicant profile update revalidates existing applications', () => {
    it('leaves eligible ACTIVE applications unchanged', async () => {
      const { provider } = await registerProvider();
      const listing = await publishListingWithRequirements(provider.id, {
        suitableForPeopleCount: 1,
      });

      const applicant = await registerApplicant();
      await updateApplicantProfile(applicant, {
        adultsCount: 1,
        childrenCount: 0,
      });
      const entry = await applyToListing(applicant, listing.id);
      expect(entry['status']).toBe(ApplicationStatus.ACTIVE);

      await updateApplicantProfile(applicant, {
        adultsCount: 1,
        childrenCount: 0,
      });

      const application = await getPrisma().application.findUnique({
        where: { id: entry['id'] as string },
      });
      expect(application?.status).toBe(ApplicationStatus.ACTIVE);
    });

    it('rejects an ineligible ACTIVE application and promotes the next eligible WAITING applicant', async () => {
      const { provider } = await registerProvider();
      const listing = await publishListingWithRequirements(provider.id, {
        suitableForPeopleCount: 1,
      });

      const applicants: ReturnType<typeof request.agent>[] = [];
      for (let i = 0; i < 6; i += 1) {
        const agent = await registerApplicant();
        await updateApplicantProfile(agent, {
          adultsCount: 1,
          childrenCount: 0,
        });
        applicants.push(agent);
      }

      const entries: Record<string, unknown>[] = [];
      for (const agent of applicants) {
        const entry = await applyToListing(agent, listing.id);
        entries.push(entry);
      }
      expect(
        entries.filter((e) => e['status'] === ApplicationStatus.ACTIVE).length,
      ).toBe(5);
      const waitingEntry = entries.find(
        (e) => e['status'] === ApplicationStatus.WAITING,
      );
      expect(waitingEntry).toBeTruthy();

      await updateApplicantProfile(applicants[0], {
        adultsCount: 2,
        childrenCount: 0,
      });

      const rejectedApplication = await getPrisma().application.findUnique({
        where: { id: entries[0]['id'] as string },
      });
      expect(rejectedApplication?.status).toBe(ApplicationStatus.REJECTED);
      expect(rejectedApplication?.publicReason).toBe(
        ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
      );

      const promotedApplication = await getPrisma().application.findUnique({
        where: { id: waitingEntry?.['id'] as string },
      });
      expect(promotedApplication?.status).toBe(ApplicationStatus.ACTIVE);
    });

    it('rejects an ineligible WAITING application without promoting', async () => {
      const { provider } = await registerProvider();
      const listing = await publishListingWithRequirements(provider.id, {
        suitableForPeopleCount: 1,
      });

      const applicants: ReturnType<typeof request.agent>[] = [];
      for (let i = 0; i < 6; i += 1) {
        const agent = await registerApplicant();
        await updateApplicantProfile(agent, {
          adultsCount: 1,
          childrenCount: 0,
        });
        applicants.push(agent);
      }

      const entries: Record<string, unknown>[] = [];
      for (const agent of applicants) {
        const entry = await applyToListing(agent, listing.id);
        entries.push(entry);
      }
      const waitingEntry = entries.find(
        (e) => e['status'] === ApplicationStatus.WAITING,
      );
      expect(waitingEntry).toBeTruthy();

      const waitingApplicantIndex = entries.findIndex(
        (e) => e['id'] === waitingEntry?.['id'],
      );
      await updateApplicantProfile(applicants[waitingApplicantIndex], {
        adultsCount: 2,
        childrenCount: 0,
      });

      const rejectedApplication = await getPrisma().application.findUnique({
        where: { id: waitingEntry?.['id'] as string },
      });
      expect(rejectedApplication?.status).toBe(ApplicationStatus.REJECTED);
      expect(rejectedApplication?.publicReason).toBe(
        ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
      );

      const activeCount = await getPrisma().application.count({
        where: { listingId: listing.id, status: ApplicationStatus.ACTIVE },
      });
      expect(activeCount).toBe(5);
    });

    it('does not auto-revive a rejected application when the profile becomes eligible again', async () => {
      const { provider } = await registerProvider();
      const listing = await publishListingWithRequirements(provider.id, {
        suitableForPeopleCount: 1,
      });

      const applicant = await registerApplicant();
      await updateApplicantProfile(applicant, {
        adultsCount: 1,
        childrenCount: 0,
      });
      const entry = await applyToListing(applicant, listing.id);
      expect(entry['status']).toBe(ApplicationStatus.ACTIVE);

      await updateApplicantProfile(applicant, {
        adultsCount: 2,
        childrenCount: 0,
      });

      const rejectedApplication = await getPrisma().application.findUnique({
        where: { id: entry['id'] as string },
      });
      expect(rejectedApplication?.status).toBe(ApplicationStatus.REJECTED);

      await updateApplicantProfile(applicant, {
        adultsCount: 1,
        childrenCount: 0,
      });

      const stillRejectedApplication = await getPrisma().application.findUnique(
        {
          where: { id: entry['id'] as string },
        },
      );
      expect(stillRejectedApplication?.status).toBe(ApplicationStatus.REJECTED);
    });
  });

  describe('Application lifecycle timestamps and exited applications', () => {
    it('persists activeAt on ACTIVE create and withdrawnAt on ACTIVE withdraw', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicant = await registerApplicant();

      const entry = await applyToListing(applicant, listing.id);
      expect(entry['status']).toBe(ApplicationStatus.ACTIVE);

      const createdPersisted = await getPrisma().application.findUnique({
        where: { id: entry['id'] as string },
      });
      expect(createdPersisted?.activeAt).toBeInstanceOf(Date);
      expect(createdPersisted?.createdAt?.getTime()).toBe(
        createdPersisted?.activeAt?.getTime(),
      );

      await applicant
        .delete(`/api/v1/applicant/applications/${entry['id'] as string}`)
        .expect(200);

      const withdrawnPersisted = await getPrisma().application.findUnique({
        where: { id: entry['id'] as string },
      });
      expect(withdrawnPersisted?.status).toBe(ApplicationStatus.WITHDRAWN);
      expect(withdrawnPersisted?.withdrawnAt).toBeInstanceOf(Date);

      const exitedResponse = await providerAgent
        .get(`/api/v1/provider/listings/${listing.id}/exited-applications`)
        .expect(200);
      const exited: unknown = exitedResponse.body;
      expect(Array.isArray((exited as Record<string, unknown>)['items'])).toBe(
        true,
      );
      expect((exited as Record<string, unknown>)['totalCount']).toBe(1);
      const exitedItems = (exited as Record<string, unknown>)['items'] as Array<
        Record<string, unknown>
      >;
      expect(exitedItems).toHaveLength(1);
      const exitedRecord = exitedItems[0];
      expect(exitedRecord['id']).toBe(entry['id']);
      expect(exitedRecord['status']).toBe(ApplicationStatus.WITHDRAWN);
      expect(exitedRecord['applicantName']).toBeTruthy();
      expect(exitedRecord['publicReason']).toBeNull();
      expect(new Date(exitedRecord['exitedAt'] as string).getTime()).toBe(
        withdrawnPersisted!.withdrawnAt!.getTime(),
      );
    });

    it('does not set withdrawnAt for a WAITING withdrawal and excludes it from exited', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 6 }, () => registerApplicant()),
      );
      const entries: Array<{
        agent: ReturnType<typeof request.agent>;
        id: string;
      }> = [];
      for (const agent of agents) {
        const res = await applyToListing(agent, listing.id);
        entries.push({
          agent,
          id: res['id'] as string,
        });
      }

      expect(entries[0].id).toBeTruthy();
      expect(entries[5].id).toBeTruthy();

      const waitingPersisted = await getPrisma().application.findUnique({
        where: { id: entries[5].id },
      });
      expect(waitingPersisted?.status).toBe(ApplicationStatus.WAITING);
      expect(waitingPersisted?.activeAt).toBeNull();
      expect(waitingPersisted?.withdrawnAt).toBeNull();

      await entries[5].agent
        .delete(`/api/v1/applicant/applications/${entries[5].id}`)
        .expect(200);

      const waitingAfterWithdraw = await getPrisma().application.findUnique({
        where: { id: entries[5].id },
      });
      expect(waitingAfterWithdraw?.status).toBe(ApplicationStatus.WITHDRAWN);
      expect(waitingAfterWithdraw?.withdrawnAt).toBeNull();

      await entries[0].agent
        .delete(`/api/v1/applicant/applications/${entries[0].id}`)
        .expect(200);

      const exitedResponse = await providerAgent
        .get(`/api/v1/provider/listings/${listing.id}/exited-applications`)
        .expect(200);
      const exited: unknown = exitedResponse.body;
      const exitedItems = (exited as Record<string, unknown>)['items'] as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(exitedItems)).toBe(true);
      expect((exited as Record<string, unknown>)['totalCount']).toBe(1);
      const exitedIds = exitedItems.map((item) => item['id']);
      expect(exitedIds).toContain(entries[0].id);
      expect(exitedIds).not.toContain(entries[5].id);
    });

    it('includes a REJECTED ACTIVE application in exited-applications with exitedAt equal to rejectedAt', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);
      const applicant = await registerApplicant();

      const entry = await applyToListing(applicant, listing.id);
      expect(entry['status']).toBe(ApplicationStatus.ACTIVE);
      const entryId = entry['id'] as string;

      await providerAgent
        .patch(`/api/v1/provider/applications/${entryId}/reject`)
        .send()
        .expect(200);

      const rejectedPersisted = await getPrisma().application.findUnique({
        where: { id: entryId },
      });
      expect(rejectedPersisted?.status).toBe(ApplicationStatus.REJECTED);
      expect(rejectedPersisted?.publicReason).toBe(
        ApplicationRejectionReason.NOT_SELECTED,
      );
      expect(rejectedPersisted?.rejectedAt).toBeInstanceOf(Date);
      expect(rejectedPersisted?.activeAt).toBeInstanceOf(Date);

      const exitedResponse = await providerAgent
        .get(`/api/v1/provider/listings/${listing.id}/exited-applications`)
        .expect(200);
      const exited: unknown = exitedResponse.body;
      const exitedItems = (exited as Record<string, unknown>)['items'] as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(exitedItems)).toBe(true);
      expect((exited as Record<string, unknown>)['totalCount']).toBe(1);
      const exitedRecord = exitedItems.find((item) => item['id'] === entryId);
      expect(exitedRecord).toBeTruthy();
      expect(exitedRecord!['status']).toBe(ApplicationStatus.REJECTED);
      expect(exitedRecord!['publicReason']).toBe(
        ApplicationRejectionReason.NOT_SELECTED,
      );
      expect(new Date(exitedRecord!['exitedAt'] as string).getTime()).toBe(
        rejectedPersisted!.rejectedAt!.getTime(),
      );
    });

    it('returns at most 5 newest exited applications with totalCount', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 7 }, () => registerApplicant()),
      );
      const entries: Record<string, unknown>[] = [];
      for (const agent of agents) {
        const entry = await applyToListing(agent, listing.id);
        entries.push(entry);
      }

      for (let i = 0; i < entries.length; i += 1) {
        const applicationId = entries[i]['id'] as string;
        await agents[i]
          .delete(`/api/v1/applicant/applications/${applicationId}`)
          .expect(200);
      }

      const baseTime = new Date('2024-06-01T00:00:00.000Z').getTime();
      await Promise.all(
        entries.map((entry, index) =>
          getPrisma().application.update({
            where: { id: entry['id'] as string },
            data: { withdrawnAt: new Date(baseTime + index * 60000) },
          }),
        ),
      );

      const exitedResponse = await providerAgent
        .get(`/api/v1/provider/listings/${listing.id}/exited-applications`)
        .expect(200);
      const exited: unknown = exitedResponse.body;
      const exitedItems = (exited as Record<string, unknown>)['items'] as Array<
        Record<string, unknown>
      >;

      expect(exitedItems).toHaveLength(5);
      expect((exited as Record<string, unknown>)['totalCount']).toBe(7);

      const expectedIds = [...entries]
        .reverse()
        .slice(0, 5)
        .map((entry) => entry['id'] as string);
      const actualIds = exitedItems.map((item) => item['id'] as string);
      expect(actualIds).toEqual(expectedIds);
    });

    it('sets activeAt when a WAITING applicant is promoted to ACTIVE', async () => {
      const { agent: providerAgent, provider } = await registerProvider();
      const listing = await publishListing(provider.id);

      const agents = await Promise.all(
        Array.from({ length: 6 }, () => registerApplicant()),
      );
      const entries = await Promise.all(
        agents.map((agent) =>
          applyToListing(agent, listing.id).then((entry) => ({
            agent,
            id: entry['id'] as string,
            status: entry['status'] as string,
          })),
        ),
      );

      const activeEntries = entries.filter(
        (e) => e.status === ApplicationStatus.ACTIVE,
      );
      const waitingEntry = entries.find(
        (e) => e.status === ApplicationStatus.WAITING,
      );
      expect(activeEntries).toHaveLength(5);
      expect(waitingEntry).toBeTruthy();

      const promotedBefore = await getPrisma().application.findUnique({
        where: { id: waitingEntry!.id },
      });
      expect(promotedBefore?.status).toBe(ApplicationStatus.WAITING);
      expect(promotedBefore?.activeAt).toBeNull();

      const firstActive = activeEntries[0];
      await providerAgent
        .patch(`/api/v1/provider/applications/${firstActive.id}/reject`)
        .send()
        .expect(200);

      const promoted = await getPrisma().application.findUnique({
        where: { id: waitingEntry!.id },
      });
      expect(promoted?.status).toBe(ApplicationStatus.ACTIVE);
      expect(promoted?.activeAt).toBeInstanceOf(Date);

      const activeResponse = await providerAgent
        .get(`/api/v1/provider/listings/${listing.id}/active-applications`)
        .expect(200);
      const activeBody: unknown = activeResponse.body;
      expect(Array.isArray(activeBody)).toBe(true);
      const activeRecords = activeBody as Array<Record<string, unknown>>;
      const promotedRecord = activeRecords.find(
        (item) => item['id'] === waitingEntry!.id,
      );
      expect(promotedRecord).toBeTruthy();
      expect(promotedRecord!['status']).toBe(ApplicationStatus.ACTIVE);
      expect(promotedRecord!['activeAt']).toBeTruthy();
      expect(new Date(promotedRecord!['activeAt'] as string).getTime()).toBe(
        promoted!.activeAt!.getTime(),
      );
    });
  });
});
