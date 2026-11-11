import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import passport from 'passport';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';
import { clearE2EData } from './e2e-cleanup';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

jest.setTimeout(30000);

describe('Minimal shared-db registration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pool: Pool;

  beforeAll(async () => {
    const databaseUrl = process.env['E2E_DATABASE_URL'];
    if (!databaseUrl || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true') {
      throw new Error('E2E database required');
    }
    assertSafeE2EDatabaseUrl(databaseUrl);
    process.env['DATABASE_URL'] = databaseUrl;
    process.env['NODE_ENV'] = 'test';
    process.env['SESSION_SECRET'] =
      'e2e-session-secret-at-least-thirty-two-characters';
    process.env['FRONTEND_URL'] = 'http://localhost:3001';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.use(app.get(SessionInfrastructureService).createMiddleware());
    app.use(passport.initialize());
    app.use(passport.session());
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    pool = new Pool({ connectionString: databaseUrl });
    await clearE2EData(prisma);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('creates session row and grant on register', async () => {
    const email = `${randomUUID()}@minimal.renyqo.test`;
    const agent = request.agent(await app.getUrl());
    const response = await agent.post('/api/v1/auth/register').send({
      name: 'Minimal Applicant',
      email,
      password: 'StrongPass123',
      role: 'applicant',
      acceptedTerms: true,
      acceptedPrivacy: true,
    });
    const sessions = await pool.query(
      'SELECT count(*)::int AS c FROM public.user_sessions',
    );
    const grants = await pool.query(
      'SELECT count(*)::int AS c FROM public.session_auth_grants',
    );
    const sessionCount = Number((sessions.rows[0] as { c: number | string }).c);
    const grantCount = Number((grants.rows[0] as { c: number | string }).c);
    expect({
      status: response.status,
      sessions: sessionCount,
      grants: grantCount,
    }).toEqual({
      status: 201,
      sessions: 1,
      grants: 1,
    });
  });
});
