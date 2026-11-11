import { assertE2EDatabaseEmpty, clearE2EData } from './e2e-cleanup';
import { ViewingClock } from '../src/application-viewings/application-viewing.policy';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sign } from 'cookie-signature';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import passport from 'passport';
import { io, type Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Role } from '../src/generated/prisma/enums';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';
import {
  createPublishedListingForProvider,
  ensurePersonalWorkspaceForProvider,
} from './e2e-workspace-listing';
import {
  applicantAuthorityFor,
  authorizationContextFor,
  providerActorFor,
} from './e2e-provider-context';
import { applyCanonicalSharedE2EProcessEnv } from './e2e-shared-test-env';
export async function realtimeTestApp(
  options: {
    enabled?: boolean;
    validation?: boolean;
    clock?: () => Date;
    handshakeLimit?: number;
    connectionLimit?: number;
    sessionLimit?: number;
    outboxDispatch?: boolean;
    viewingExpiry?: boolean;
  } = {},
) {
  const database = process.env['E2E_DATABASE_URL'];
  if (!database || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
    throw new Error('Dedicated E2E database and reset marker required');
  assertSafeE2EDatabaseUrl(database);
  const envSnapshot = {
    DATABASE_URL: process.env['DATABASE_URL'],
    NODE_ENV: process.env['NODE_ENV'],
    SESSION_SECRET: process.env['SESSION_SECRET'],
    FRONTEND_URL: process.env['FRONTEND_URL'],
    REALTIME_ENABLED: process.env['REALTIME_ENABLED'],
    OUTBOX_DISPATCH_ENABLED: process.env['OUTBOX_DISPATCH_ENABLED'],
    VIEWING_EXPIRY_ENABLED: process.env['VIEWING_EXPIRY_ENABLED'],
    REALTIME_SESSION_RECHECK_INTERVAL_MS:
      process.env['REALTIME_SESSION_RECHECK_INTERVAL_MS'],
    REALTIME_MAX_CONNECTIONS_PER_SESSION:
      process.env['REALTIME_MAX_CONNECTIONS_PER_SESSION'],
    REALTIME_MAX_CONNECTIONS: process.env['REALTIME_MAX_CONNECTIONS'],
    REALTIME_HANDSHAKES_PER_IP_PER_MINUTE:
      process.env['REALTIME_HANDSHAKES_PER_IP_PER_MINUTE'],
  };
  const secret = 'realtime-e2e-session-secret-at-least-32-characters';
  const config = new ConfigService({
    DATABASE_URL: database,
    SESSION_SECRET: secret,
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:3001',
    REALTIME_ENABLED: options.enabled === false ? 'false' : 'true',
    OUTBOX_DISPATCH_ENABLED: options.outboxDispatch === true ? 'true' : 'false',
    VIEWING_EXPIRY_ENABLED: options.viewingExpiry === true ? 'true' : 'false',
    VIEWING_EXPIRY_INTERVAL_MS: '1000',
    VIEWING_EXPIRY_BATCH_SIZE: '25',
    REALTIME_SESSION_RECHECK_INTERVAL_MS: '50',
    REALTIME_MAX_CONNECTIONS_PER_SESSION: String(options.sessionLimit ?? 2),
    REALTIME_MAX_CONNECTIONS: String(options.connectionLimit ?? 1000),
    REALTIME_HANDSHAKES_PER_IP_PER_MINUTE: String(options.handshakeLimit ?? 60),
  });
  process.env['DATABASE_URL'] = database;
  process.env['NODE_ENV'] = 'test';
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ViewingClock)
    .useValue({ now: () => options.clock?.() ?? new Date() })
    .overrideProvider(ConfigService)
    .useValue(config)
    .compile();
  const app = module.createNestApplication();
  if (options.validation)
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
  app.setGlobalPrefix('api/v1');
  app.use(app.get(SessionInfrastructureService).createMiddleware());
  app.use(passport.initialize());
  app.use(passport.session());
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const prisma = app.get(PrismaService);
  const sockets: Socket[] = [];

  async function sessionFor(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const id = randomUUID();
    await prisma.userSession.create({
      data: {
        sid: id,
        sess: {
          passport: { user: { id: userId, authVersion: user.authVersion } },
          cookie: {
            originalMaxAge: 60000,
            expires: new Date(Date.now() + 60000).toISOString(),
            httpOnly: true,
          },
        },
        expire: new Date(Date.now() + 60000),
      },
    });
    await prisma.sessionAuthGrant.create({
      data: { sid: id, userId, authVersion: user.authVersion },
    });
    return { id, cookie: `sid=${encodeURIComponent(`s:${sign(id, secret)}`)}` };
  }
  async function user(role: Role = Role.APPLICANT) {
    const row = await prisma.user.create({
      data: {
        name: 'Realtime test',
        email: `${randomUUID()}@e2e.renyqo.test`,
        role,
        passwordHash: 'unused',
        acceptedTermsAt: new Date(),
        acceptedPrivacyAt: new Date(),
      },
    });
    if (role === Role.PROVIDER) {
      await ensurePersonalWorkspaceForProvider(prisma, row.id);
    }
    return { userId: row.id, ...(await sessionFor(row.id)) };
  }
  async function publishedListing(
    providerUserId: string,
    overrides: Parameters<typeof createPublishedListingForProvider>[2] = {},
  ) {
    return createPublishedListingForProvider(prisma, providerUserId, overrides);
  }
  async function providerActor(providerUserId: string) {
    return providerActorFor(prisma, providerUserId);
  }
  async function applicantAuthority(applicantUserId: string) {
    return applicantAuthorityFor(prisma, applicantUserId);
  }
  async function providerContext(providerUserId: string) {
    return authorizationContextFor(prisma, providerUserId);
  }
  function client(
    cookie?: string,
    origin: string | null = 'http://localhost:3001',
    auth = {},
    target: 'realtime' | 'default' = 'realtime',
    transports: ('websocket' | 'polling')[] = ['websocket'],
  ) {
    const socket = io(target === 'realtime' ? `${url}/realtime` : url, {
      transports,
      reconnection: false,
      autoConnect: false,
      timeout: 2000,
      auth,
      extraHeaders: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    sockets.push(socket);
    return socket;
  }
  async function close(options?: { finalize?: boolean }) {
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    sockets.length = 0;
    await app.close();
    if (options?.finalize === false) return;
    // The app owns Prisma, so cleanup uses a fresh connection after shutdown tests.
    if (
      !database ||
      process.env['DATABASE_URL'] !== database ||
      process.env['NODE_ENV'] !== 'test' ||
      process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true'
    )
      throw new Error('Unsafe E2E cleanup');
    assertSafeE2EDatabaseUrl(database);
    const cleanup = new PrismaService();
    await cleanup.$connect();
    try {
      await clearE2EData(cleanup);
      await assertE2EDatabaseEmpty(cleanup);
    } finally {
      await cleanup.onModuleDestroy();
    }
    applyCanonicalSharedE2EProcessEnv();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  }
  return {
    app,
    prisma,
    url,
    user,
    sessionFor,
    client,
    close,
    publishedListing,
    providerActor,
    applicantAuthority,
    providerContext,
  };
}

export function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
}
export function disconnected(socket: Socket): Promise<void> {
  if (!socket.connected) return Promise.resolve();
  return new Promise((resolve) => socket.once('disconnect', () => resolve()));
}
export async function quietPeriod(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
}
