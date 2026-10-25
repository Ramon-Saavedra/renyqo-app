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

export async function realtimeTestApp(
  options: {
    enabled?: boolean;
    validation?: boolean;
    clock?: () => Date;
    handshakeLimit?: number;
    connectionLimit?: number;
    sessionLimit?: number;
  } = {},
) {
  const database = process.env['E2E_DATABASE_URL'];
  if (!database || process.env['E2E_DATABASE_ALLOW_RESET'] !== 'true')
    throw new Error('Dedicated E2E database and reset marker required');
  assertSafeE2EDatabaseUrl(database);
  const secret = 'realtime-e2e-session-secret-at-least-32-characters';
  const config = new ConfigService({
    DATABASE_URL: database,
    SESSION_SECRET: secret,
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:3001',
    REALTIME_ENABLED: options.enabled === false ? 'false' : 'true',
    OUTBOX_DISPATCH_ENABLED: 'false',
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
  const userIds: string[] = [];
  const sessionIds: string[] = [];

  async function sessionFor(userId: string) {
    const id = randomUUID();
    sessionIds.push(id);
    await prisma.userSession.create({
      data: {
        sid: id,
        sess: {
          passport: { user: userId },
          cookie: {
            originalMaxAge: 60000,
            expires: new Date(Date.now() + 60000).toISOString(),
            httpOnly: true,
          },
        },
        expire: new Date(Date.now() + 60000),
      },
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
    userIds.push(row.id);
    return { userId: row.id, ...(await sessionFor(row.id)) };
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
  async function close() {
    for (const socket of sockets) socket.disconnect();
    await app.close();
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
      await cleanup.outboxEvent.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            {
              applicationId: {
                in: (
                  await cleanup.application.findMany({
                    where: { applicantId: { in: userIds } },
                    select: { id: true },
                  })
                ).map((row) => row.id),
              },
            },
          ],
        },
      });
      await cleanup.$executeRaw`TRUNCATE TABLE application_no_show_consequences, application_consideration_positions, viewing_command_receipts, viewing_workflows, viewing_proposals, viewing_appointments, application_viewing_interests, application_viewing_outcomes, application_viewings`;
      await cleanup.application.deleteMany({
        where: { applicantId: { in: userIds } },
      });
      await cleanup.listingEvent.deleteMany({
        where: { listing: { providerId: { in: userIds } } },
      });
      await cleanup.listing.deleteMany({
        where: { providerId: { in: userIds } },
      });
      await cleanup.userSession.deleteMany({
        where: { sid: { in: sessionIds } },
      });
      await cleanup.applicantProfile.deleteMany({
        where: { applicantId: { in: userIds } },
      });
      await cleanup.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await cleanup.$disconnect();
    }
  }
  return { app, prisma, url, user, sessionFor, client, close };
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
