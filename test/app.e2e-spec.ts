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

const defaultE2eDatabaseUrl = 'postgresql://ci:ci@localhost:5432/ci';
const sessionSecret = 'e2e-session-secret-at-least-thirty-two-characters';
const userPassword = 'StrongPass123';

let app: INestApplication | undefined;
let prisma: PrismaService | undefined;
let sessionStore: PgSessionStore | undefined;
let emailSequence = 0;

function useE2eEnvironment(): void {
  process.env['NODE_ENV'] = 'test';
  process.env['PORT'] = '3000';
  process.env['DATABASE_URL'] =
    process.env['E2E_DATABASE_URL'] ?? defaultE2eDatabaseUrl;
  process.env['SESSION_SECRET'] = sessionSecret;
  process.env['FRONTEND_URL'] = 'http://localhost:3001';
}

function getServer(): RequestTarget {
  if (!app) {
    throw new Error('E2E app has not been initialized.');
  }

  return app.getHttpServer() as RequestTarget;
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
  return response.body as SafeUserBody;
}

function responseBody(response: Response): Record<string, unknown> {
  return response.body as Record<string, unknown>;
}

function expectSessionCookie(response: Response): void {
  expect(response.headers['set-cookie']).toBeDefined();
}

async function clearDatabase(): Promise<void> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('E2E database cleanup is only allowed in test mode.');
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
});
