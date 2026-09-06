import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import passport from 'passport';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import type { EnvironmentVariables } from '../src/config/env.validation';
import type { ListingAssistanceFile } from '../src/listing-assistance/listing-assistance-upload.constants';
import type {
  AiProvider,
  ListingExtractionCandidate,
  ListingExtractionValues,
} from '../src/listing-assistance/providers/ai-provider.interface';
import { OpenAiProvider } from '../src/listing-assistance/providers/openai.provider';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  assertSafeE2EDatabaseUrl,
  getE2EDatabaseName,
} from './e2e-database-safety';

type RequestTarget = Parameters<typeof request>[0];
type RequestAgent = ReturnType<typeof request.agent>;
type PgSessionStore = InstanceType<ReturnType<typeof connectPgSimple>>;

type RegisterPayload = {
  name: string;
  email: string;
  password: string;
  role: 'applicant' | 'provider';
  acceptedTerms: true;
  acceptedPrivacy: true;
  providerType?: 'private';
};

type ExtractionResponseBody = {
  values: Record<string, unknown>;
  requiredMissingFields: string[];
  recommendedMissingFields: string[];
  inconsistencies: unknown[];
  warnings: string[];
};

const sessionSecret = 'e2e-session-secret-at-least-thirty-two-characters';
const password = 'StrongPass123';
const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const validWave = Buffer.alloc(46);
validWave.write('RIFF', 0);
validWave.writeUInt32LE(38, 4);
validWave.write('WAVE', 8);
validWave.write('fmt ', 12);
validWave.writeUInt32LE(16, 16);
validWave.writeUInt16LE(1, 20);
validWave.writeUInt16LE(1, 22);
validWave.writeUInt32LE(8000, 24);
validWave.writeUInt32LE(16000, 28);
validWave.writeUInt16LE(2, 32);
validWave.writeUInt16LE(16, 34);
validWave.write('data', 36);
validWave.writeUInt32LE(2, 40);

let app: INestApplication | undefined;
let prisma: PrismaService | undefined;
let sessionStore: PgSessionStore | undefined;
let providerStub: OpenAiProviderStub | undefined;
let emailSequence = 0;

function emptyValues(
  overrides: Partial<ListingExtractionValues> = {},
): ListingExtractionValues {
  return {
    objectType: null,
    city: null,
    zip: null,
    street: null,
    district: null,
    livingArea: null,
    rooms: null,
    bedrooms: null,
    coldRent: null,
    additionalCosts: null,
    depositMonths: null,
    availableFrom: null,
    title: null,
    shortDescription: null,
    minimumHouseholdNetIncome: null,
    schufaRequired: null,
    incomeProofRequired: null,
    suitableForPeopleCount: null,
    petsPolicy: null,
    smokingPolicy: null,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<ListingExtractionValues> = {},
): ListingExtractionCandidate {
  return {
    values: emptyValues(overrides),
    depositEvidence: null,
    conflictingFields: [],
    uncertainFields: [],
  };
}

class OpenAiProviderStub implements AiProvider {
  transcript = 'Apartment in Cologne';
  readonly extractFromText = jest.fn<
    (text: string) => Promise<ListingExtractionCandidate>
  >(() => Promise.resolve(candidate({ city: 'Berlin', coldRent: 1200 })));
  readonly extractFromPdf = jest.fn<
    (file: ListingAssistanceFile) => Promise<ListingExtractionCandidate>
  >(() => Promise.resolve(candidate({ city: 'Hamburg' })));
  readonly transcribeAudio = jest.fn<
    (file: ListingAssistanceFile) => Promise<string>
  >(() => Promise.resolve(this.transcript));

  reset(): void {
    this.transcript = 'Apartment in Cologne';
    this.extractFromText.mockClear();
    this.extractFromPdf.mockClear();
    this.transcribeAudio.mockClear();
  }
}

function useE2eEnvironment(): void {
  const databaseUrl = process.env['E2E_DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('E2E_DATABASE_URL is required for destructive E2E tests.');
  }
  assertSafeE2EDatabaseUrl(databaseUrl);
  if (process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
    throw new Error(
      'E2E_DATABASE_ALLOW_RESET=true is required for destructive E2E tests.',
    );
  }

  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['SESSION_SECRET'] = sessionSecret;
  process.env['FRONTEND_URL'] = 'http://localhost:3001';
  process.env['AI_RATE_LIMIT_WINDOW_MS'] = '60000';
  process.env['AI_TEXT_RATE_LIMIT'] = '10';
  process.env['AI_PDF_RATE_LIMIT'] = '3';
  process.env['AI_AUDIO_RATE_LIMIT'] = '3';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isExtractionResponseBody(
  value: unknown,
): value is ExtractionResponseBody {
  return (
    isRecord(value) &&
    isRecord(value.values) &&
    isStringArray(value.requiredMissingFields) &&
    isStringArray(value.recommendedMissingFields) &&
    Array.isArray(value.inconsistencies) &&
    isStringArray(value.warnings)
  );
}

function extractionBody(response: Response): ExtractionResponseBody {
  const body: unknown = response.body;
  if (!isExtractionResponseBody(body)) {
    throw new Error('E2E response does not match the extraction contract.');
  }
  return body;
}

function isRequestTarget(value: unknown): value is RequestTarget {
  return (
    typeof value === 'string' ||
    value instanceof URL ||
    (typeof value === 'object' && value !== null)
  );
}

function getServer(): RequestTarget {
  if (!app) throw new Error('E2E app has not been initialized.');
  const server: unknown = app.getHttpServer();
  if (!isRequestTarget(server)) {
    throw new Error('E2E app server is not a valid request target.');
  }
  return server;
}

function getPrisma(): PrismaService {
  if (!prisma) throw new Error('Prisma service has not been initialized.');
  return prisma;
}

function getProviderStub(): OpenAiProviderStub {
  if (!providerStub) throw new Error('OpenAI stub has not been initialized.');
  return providerStub;
}

function uniqueEmail(prefix: string): string {
  emailSequence += 1;
  return `${prefix}-${emailSequence}@listing-ai.e2e.test`;
}

function registrationPayload(role: 'applicant' | 'provider'): RegisterPayload {
  return {
    name: role === 'provider' ? 'AI Provider' : 'AI Applicant',
    email: uniqueEmail(role),
    password,
    role,
    acceptedTerms: true,
    acceptedPrivacy: true,
    ...(role === 'provider' ? { providerType: 'private' as const } : {}),
  };
}

async function registeredAgent(
  role: 'applicant' | 'provider',
): Promise<RequestAgent> {
  const agent = request.agent(getServer());
  await agent
    .post('/api/v1/auth/register')
    .send(registrationPayload(role))
    .expect(201);
  return agent;
}

async function clearDatabase(): Promise<void> {
  const e2eDatabaseUrl = process.env['E2E_DATABASE_URL'];
  const activeDatabaseUrl = process.env['DATABASE_URL'];
  if (!e2eDatabaseUrl || !activeDatabaseUrl) {
    throw new Error('Both E2E database URLs are required for cleanup.');
  }
  assertSafeE2EDatabaseUrl(e2eDatabaseUrl);
  if (
    getE2EDatabaseName(activeDatabaseUrl) !== getE2EDatabaseName(e2eDatabaseUrl)
  ) {
    throw new Error('E2E database URLs must target the same database.');
  }
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('E2E cleanup is only allowed in test mode.');
  }

  const client = getPrisma();
  await client.application.deleteMany();
  await client.listingReport.deleteMany();
  await client.savedListing.deleteMany();
  await client.listingImage.deleteMany();
  await client.listingEvent.deleteMany();
  await client.listing.deleteMany();
  await client.applicantProfile.deleteMany();
  await client.passwordResetToken.deleteMany();
  await client.userSession.deleteMany();
  await client.user.deleteMany();
}

function attachPdf(agent: RequestAgent, field = 'file') {
  return agent
    .post('/api/v1/provider/listings/ai-extractions/pdf')
    .attach(field, validPdf, {
      filename: 'listing.pdf',
      contentType: 'application/pdf',
    });
}

function attachAudio(agent: RequestAgent, field = 'file') {
  return agent
    .post('/api/v1/provider/listings/ai-extractions/audio')
    .attach(field, validWave, {
      filename: 'listing.wav',
      contentType: 'audio/wav',
    });
}

describe('Listing assistance API E2E', () => {
  beforeAll(async () => {
    useE2eEnvironment();
    providerStub = new OpenAiProviderStub();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OpenAiProvider)
      .useValue(providerStub)
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
    await app.init();
    prisma = app.get(PrismaService);
    await clearDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    getProviderStub().reset();
  });

  afterAll(async () => {
    if (prisma) await clearDatabase();
    if (app) await app.close();
    sessionStore?.close();
    app = undefined;
    prisma = undefined;
    sessionStore = undefined;
    providerStub = undefined;
  });

  it.each([
    [
      'text',
      (agent: RequestAgent) =>
        agent
          .post('/api/v1/provider/listings/ai-extractions/text')
          .send({ text: 'Berlin' }),
    ],
    ['pdf', (agent: RequestAgent) => attachPdf(agent)],
    ['audio', (agent: RequestAgent) => attachAudio(agent)],
  ])('requires a Provider for %s extraction', async (_name, sendRequest) => {
    await sendRequest(request.agent(getServer())).expect(401);
    const applicant = await registeredAgent('applicant');
    await sendRequest(applicant).expect(403);
  });

  it('accepts short complementary text without persistence', async () => {
    const provider = await registeredAgent('provider');
    const before = await getPrisma().listing.count();

    const immediate = extractionBody(
      await provider
        .post('/api/v1/provider/listings/ai-extractions/text')
        .send({ text: 'ab sofort' })
        .expect(201),
    );
    expect(immediate.values.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const pets = extractionBody(
      await provider
        .post('/api/v1/provider/listings/ai-extractions/text')
        .send({ text: 'Haustiere erlaubt' })
        .expect(201),
    );
    expect(pets.values).toBeDefined();
    expect(await getPrisma().listing.count()).toBe(before);
  });

  it('normalizes deterministic evidence from an audio transcript', async () => {
    const provider = await registeredAgent('provider');
    getProviderStub().transcript = 'Wohnfläche 85 qm, ab sofort';

    const body = extractionBody(await attachAudio(provider).expect(201));

    expect(body.values.livingArea).toBe(85);
    expect(body.values.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    [
      'pdf',
      (agent: RequestAgent) =>
        agent.post('/api/v1/provider/listings/ai-extractions/pdf'),
    ],
    [
      'audio',
      (agent: RequestAgent) =>
        agent.post('/api/v1/provider/listings/ai-extractions/audio'),
    ],
  ])(
    'rejects missing and wrong multipart fields for %s',
    async (_name, endpoint) => {
      const provider = await registeredAgent('provider');
      await endpoint(provider).expect(400);
      await endpoint(provider)
        .attach('upload', validPdf, {
          filename: 'wrong-field.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);
    },
  );

  it('rejects forged PDF content before invoking OpenAI', async () => {
    const provider = await registeredAgent('provider');
    await provider
      .post('/api/v1/provider/listings/ai-extractions/pdf')
      .attach('file', Buffer.from('%PDF-1.7 forged'), {
        filename: 'forged.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(getProviderStub().extractFromPdf).not.toHaveBeenCalled();
  });

  it('rejects forged audio content before invoking OpenAI', async () => {
    const provider = await registeredAgent('provider');
    await provider
      .post('/api/v1/provider/listings/ai-extractions/audio')
      .attach('file', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82]), {
        filename: 'forged.webm',
        contentType: 'audio/webm',
      })
      .expect(400);
    expect(getProviderStub().transcribeAudio).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'audio'])(
    'rejects extra multipart fields for %s before invoking OpenAI',
    async (inputType) => {
      const provider = await registeredAgent('provider');
      const endpoint = `/api/v1/provider/listings/ai-extractions/${inputType}`;
      const file = inputType === 'pdf' ? validPdf : validWave;
      const filename = inputType === 'pdf' ? 'listing.pdf' : 'listing.wav';
      const contentType = inputType === 'pdf' ? 'application/pdf' : 'audio/wav';

      await provider
        .post(endpoint)
        .field('metadata', 'unexpected')
        .attach('file', file, { filename, contentType })
        .expect(400);

      expect(getProviderStub().extractFromPdf).not.toHaveBeenCalled();
      expect(getProviderStub().transcribeAudio).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple multipart parts before invoking OpenAI', async () => {
    const provider = await registeredAgent('provider');

    await provider
      .post('/api/v1/provider/listings/ai-extractions/pdf')
      .attach('file', validPdf, {
        filename: 'listing.pdf',
        contentType: 'application/pdf',
      })
      .attach('file', validPdf, {
        filename: 'second.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    expect(getProviderStub().extractFromPdf).not.toHaveBeenCalled();
  });

  it('rejects oversized audio transcripts before structured extraction', async () => {
    const provider = await registeredAgent('provider');
    getProviderStub().transcript = 'x'.repeat(20001);

    await attachAudio(provider).expect(413);

    expect(getProviderStub().transcribeAudio).toHaveBeenCalledTimes(1);
    expect(getProviderStub().extractFromText).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME types and oversized PDF uploads', async () => {
    const provider = await registeredAgent('provider');
    await provider
      .post('/api/v1/provider/listings/ai-extractions/pdf')
      .attach('file', validPdf, {
        filename: 'listing.txt',
        contentType: 'text/plain',
      })
      .expect(400);
    await provider
      .post('/api/v1/provider/listings/ai-extractions/audio')
      .attach('file', validWave, {
        filename: 'listing.bin',
        contentType: 'application/octet-stream',
      })
      .expect(400);
    await provider
      .post('/api/v1/provider/listings/ai-extractions/pdf')
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'oversized.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);
    await provider
      .post('/api/v1/provider/listings/ai-extractions/audio')
      .attach('file', Buffer.alloc(25 * 1024 * 1024 + 1), {
        filename: 'oversized.wav',
        contentType: 'audio/wav',
      })
      .expect(413);
  });

  it('enforces text quota per Provider', async () => {
    const providerA = await registeredAgent('provider');
    for (let index = 0; index < 10; index += 1) {
      await providerA
        .post('/api/v1/provider/listings/ai-extractions/text')
        .send({ text: `Listing ${index}` })
        .expect(201);
    }
    await providerA
      .post('/api/v1/provider/listings/ai-extractions/text')
      .send({ text: 'Over quota' })
      .expect(429);

    const providerB = await registeredAgent('provider');
    await providerB
      .post('/api/v1/provider/listings/ai-extractions/text')
      .send({ text: 'Independent quota' })
      .expect(201);
  });

  it('enforces PDF quota per Provider independently from text', async () => {
    const providerA = await registeredAgent('provider');
    for (let index = 0; index < 3; index += 1) {
      await attachPdf(providerA).expect(201);
    }
    await attachPdf(providerA).expect(429);
    await providerA
      .post('/api/v1/provider/listings/ai-extractions/text')
      .send({ text: 'Independent text quota' })
      .expect(201);

    const providerB = await registeredAgent('provider');
    await attachPdf(providerB).expect(201);
  });

  it('enforces audio quota per Provider independently from PDF', async () => {
    const providerA = await registeredAgent('provider');
    for (let index = 0; index < 3; index += 1) {
      await attachAudio(providerA).expect(201);
    }
    await attachAudio(providerA).expect(429);
    await attachPdf(providerA).expect(201);

    const providerB = await registeredAgent('provider');
    await attachAudio(providerB).expect(201);
  });
});
