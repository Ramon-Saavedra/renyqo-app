import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Request, Response } from 'express';
import passport from 'passport';
import { Pool } from 'pg';
import request, { type Response as TestResponse } from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { SessionInfrastructureService } from '../src/auth/session/session-infrastructure.service';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RealtimeSessionService,
  RealtimeUnauthenticatedError,
} from '../src/realtime/realtime-session.service';
import { generateCsrfToken } from '../src/security/csrf/csrf-protection';
import { AuthRevocationService } from '../src/auth/session/auth-revocation.service';
import { RealtimeConnectionsService } from '../src/realtime/realtime-connections.service';
import { io, type Socket } from 'socket.io-client';
import { assertSafeE2EDatabaseUrl } from './e2e-database-safety';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function objectBody(response: TestResponse): Record<string, unknown> {
  const value: unknown = response.body;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object response');
  return value as Record<string, unknown>;
}

type Mode =
  | 'unchanged'
  | 'modified'
  | 'explicit-save'
  | 'modified-explicit-save'
  | 'touch'
  | 'store-touch';
type Gate = {
  mode: Mode;
  loaded: ReturnType<typeof deferred>;
  finish: ReturnType<typeof deferred>;
  request?: Request;
  lifecycle?: () => { save: number; touch: number };
};

// Stale physical recreation is allowed; authentication must reject the old version.
describe('Session persistence across password-reset revocation (isolated PostgreSQL)', () => {
  jest.setTimeout(30000);
  const schema = `session_consistency_${randomUUID().replaceAll('-', '')}`;
  const gates = new Map<string, Gate>();
  const sockets: Socket[] = [];
  let created = false;
  let admin: Pool;
  let pool: Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let infrastructure: SessionInfrastructureService;
  let realtime: RealtimeSessionService;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const url = process.env['E2E_DATABASE_URL'];
    if (!url) throw new Error('Dedicated E2E database required');
    assertSafeE2EDatabaseUrl(url);
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    admin = new Pool({ connectionString: url, max: 1 });
    const setup = await admin.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await setup.query(`SET search_path TO "${schema}"`);
      const root = resolve('prisma/migrations');
      for (const name of readdirSync(root).sort()) {
        if (name === 'migration_lock.toml') continue;
        await setup.query(
          readFileSync(resolve(root, name, 'migration.sql'), 'utf8'),
        );
      }
    } finally {
      setup.release();
    }
    pool = new Pool({ connectionString: scoped.href, max: 6 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    await prisma.$connect();
    const config = new ConfigService({
      ...process.env,
      DATABASE_URL: scoped.href,
      NODE_ENV: 'test',
      SESSION_SECRET: 'session-consistency-test-secret-at-least-32-characters',
      FRONTEND_URL: 'http://localhost:3001',
      REALTIME_ENABLED: 'true',
      REALTIME_SESSION_RECHECK_INTERVAL_MS: '50',
      OUTBOX_DISPATCH_ENABLED: 'false',
      VIEWING_EXPIRY_ENABLED: 'false',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    infrastructure = app.get(SessionInfrastructureService);
    realtime = app.get(RealtimeSessionService);
    // Real production middleware and PostgreSQL store, with only its connection schema isolated.
    app.use(infrastructure.createMiddleware());
    app.use(passport.initialize());
    app.use(passport.session());
    // Barrier is after store loading and Passport deserialization. No store operation is mocked.
    app.use(
      '/__session_consistency_hold',
      (req: Request, res: Response, next: (error?: unknown) => void) => {
        void hold(req, res).catch(next);
      },
    );
    await app.listen(0, '127.0.0.1');
    const target: unknown = app.getHttpServer();
    if (!target || typeof target !== 'object')
      throw new Error('Missing server');
    server = target as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const gate of gates.values()) gate.finish.release();
    await app?.close();
    await prisma?.$disconnect();
    await pool?.end();
    try {
      if (created) {
        if (!/^session_consistency_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe schema');
        // Only the schema successfully created by this suite is removed.
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        const remaining = await admin.query(
          'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
          [schema],
        );
        expect(remaining.rowCount).toBe(0);
      }
    } finally {
      await admin?.end();
    }
  });

  async function hold(req: Request, res: Response) {
    const key = req.query['key'];
    if (typeof key !== 'string') throw new Error('Invalid barrier key');
    const gate = gates.get(key);
    if (!gate) throw new Error('Missing barrier');
    if (!req.isAuthenticated()) throw new Error('Request A must authenticate');
    const save = jest.spyOn(req.session, 'save');
    const touch = jest.spyOn(req.session, 'touch');
    gate.request = req;
    gate.lifecycle = () => ({
      save: save.mock.calls.length,
      touch: touch.mock.calls.length,
    });
    gate.loaded.release();
    await gate.finish.promise;
    if (gate.mode.startsWith('modified')) generateCsrfToken(req);
    if (gate.mode === 'touch') req.session.touch();
    if (gate.mode === 'store-touch') {
      const store = req.sessionStore;
      if (!store.touch)
        throw new Error('Expected touch-capable PostgreSQL store');
      await new Promise<void>((resolve, reject) => {
        store.touch!(req.sessionID, req.session, (error?: unknown) =>
          error
            ? reject(
                error instanceof Error
                  ? error
                  : new Error('Store touch failed'),
              )
            : resolve(),
        );
      });
    }
    if (gate.mode.includes('explicit-save')) {
      await new Promise<void>((resolve, reject) => {
        req.session.save((error?: unknown) =>
          error
            ? reject(
                error instanceof Error
                  ? error
                  : new Error('Session save failed'),
              )
            : resolve(),
        );
      });
    }
    res.json({ authenticated: req.isAuthenticated() });
  }

  async function realtimeAccepts(cookie: string): Promise<boolean> {
    try {
      await realtime.authenticate(cookie);
      return true;
    } catch (error) {
      if (error instanceof RealtimeUnauthenticatedError) return false;
      throw error;
    }
  }

  async function owner() {
    const email = `${randomUUID()}@auth-version.test`;
    const password = 'OriginalPass123!';
    const created = await request(server)
      .post('/api/v1/auth/register')
      .send({
        name: 'Auth version',
        email,
        password,
        role: 'applicant',
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(201);
    const userId = String(objectBody(created)['id']);
    const login = async (credential = password) => {
      const response = await request(server)
        .post('/api/v1/auth/login')
        .send({ email, password: credential })
        .expect(200);
      const headers: unknown = response.headers['set-cookie'];
      if (!Array.isArray(headers) || typeof headers[0] !== 'string')
        throw new Error('Missing session cookie');
      const cookie = headers[0].split(';')[0];
      const sid = infrastructure.signedSessionId(cookie);
      if (!sid) throw new Error('Missing SID');
      return { cookie, sid };
    };
    const token = randomUUID();
    const tokenRow = await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    return {
      userId,
      token,
      tokenId: tokenRow.id,
      login,
      ...(await login()),
      reset: () =>
        app
          .get(AuthService)
          .resetPassword({ token, password: 'ResetPass456!' }),
    };
  }

  async function connectedSocket(cookie: string) {
    const socket = io(`${await app.getUrl()}/realtime`, {
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      timeout: 2000,
      extraHeaders: { Cookie: cookie, Origin: 'http://localhost:3001' },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }

  it('rolls back password, token consumption, and version together without cleanup', async () => {
    const user = await owner();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
    });
    const service = app.get(AuthRevocationService);
    const original = service.revokeAll.bind(service);
    const cleanup = jest.spyOn(service, 'cleanup');
    const fail = jest
      .spyOn(service, 'revokeAll')
      .mockImplementation(async (tx, id) => {
        await original(tx, id);
        throw new Error('failure after increment');
      });
    try {
      await expect(user.reset()).rejects.toThrow('failure after increment');
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.userId } }),
      ).toEqual(before);
      expect(
        (
          await prisma.passwordResetToken.findUniqueOrThrow({
            where: { id: user.tokenId },
          })
        ).usedAt,
      ).toBeNull();
      expect(cleanup).not.toHaveBeenCalled();
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', user.cookie)
        .expect(200);
      expect(await realtimeAccepts(user.cookie)).toBe(true);
    } finally {
      fail.mockRestore();
      cleanup.mockRestore();
    }
  });

  it('keeps durable revocation successful when session and immediate realtime cleanup fail', async () => {
    const user = await owner();
    const socket = await connectedSocket(user.cookie);
    const ended = new Promise<void>((resolve) =>
      socket.once('disconnect', () => resolve()),
    );
    const revocations = app.get(AuthRevocationService);
    const originalCleanup = revocations.cleanup.bind(revocations);
    const deletion = jest
      .spyOn(revocations, 'cleanup')
      .mockImplementation(async (snapshot) => {
        // Install the failure only after commit; Prisma's transaction client also proxies root methods.
        const failedDelete = jest
          .spyOn(prisma, '$executeRaw')
          .mockRejectedValueOnce(new Error('session cleanup unavailable'));
        try {
          await originalCleanup(snapshot);
        } finally {
          failedDelete.mockRestore();
        }
      });
    const disconnect = jest
      .spyOn(app.get(RealtimeConnectionsService), 'disconnectSessions')
      .mockImplementation(() => {
        throw new Error('immediate cleanup unavailable');
      });
    try {
      await expect(user.reset()).resolves.toEqual({
        message: 'Password has been reset.',
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } }))
          .authVersion,
      ).toBe(2);
      expect(
        (
          await prisma.passwordResetToken.findUniqueOrThrow({
            where: { id: user.tokenId },
          })
        ).usedAt,
      ).not.toBeNull();
      expect(
        await prisma.userSession.findUnique({ where: { sid: user.sid } }),
      ).not.toBeNull();
      expect(await realtimeAccepts(user.cookie)).toBe(false);
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', user.cookie)
        .expect(401);
      await ended;
      const fresh = await user.login('ResetPass456!');
      expect(await realtimeAccepts(fresh.cookie)).toBe(true);
      const freshSocket = await connectedSocket(fresh.cookie);
      expect(freshSocket.connected).toBe(true);
      await expect(user.reset()).rejects.toThrow(
        'Invalid or expired reset token',
      );
    } finally {
      deletion.mockRestore();
      disconnect.mockRestore();
    }
  });

  it('invalidates both old devices while a post-commit login survives delayed targeted cleanup', async () => {
    const user = await owner();
    const other = await user.login();
    const service = app.get(AuthRevocationService);
    const original = service.cleanup.bind(service);
    const committed = deferred(),
      finish = deferred();
    const cleanup = jest
      .spyOn(service, 'cleanup')
      .mockImplementation(async (revocation) => {
        committed.release();
        await finish.promise;
        await original(revocation);
      });
    const resetting = user.reset();
    try {
      await committed.promise;
      const fresh = await user.login('ResetPass456!');
      finish.release();
      await resetting;
      for (const stale of [user, other]) {
        expect(await realtimeAccepts(stale.cookie)).toBe(false);
        await request(server)
          .get('/api/v1/auth/me')
          .set('Cookie', stale.cookie)
          .expect(401);
      }
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', fresh.cookie)
        .expect(200);
      expect(await realtimeAccepts(fresh.cookie)).toBe(true);
      const snapshot = { authVersion: 2, sessionIds: [user.sid, other.sid] };
      await original(snapshot);
      await original(snapshot);
      expect(await realtimeAccepts(fresh.cookie)).toBe(true);
    } finally {
      finish.release();
      await resetting;
      cleanup.mockRestore();
    }
  });

  it('does not upgrade an old credential-validation snapshot when reset commits during login', async () => {
    const user = await owner();
    const auth = app.get(AuthService);
    const original = auth.login.bind(auth);
    const validated = deferred(),
      finish = deferred();
    const login = jest
      .spyOn(auth, 'login')
      .mockImplementation(async (email, password) => {
        const snapshot = await original(email, password);
        validated.release();
        await finish.promise;
        return snapshot;
      });
    const pending = user.login();
    try {
      await validated.promise;
      await user.reset();
      finish.release();
      const stale = await pending;
      expect(await realtimeAccepts(stale.cookie)).toBe(false);
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', stale.cookie)
        .expect(401);
    } finally {
      finish.release();
      await pending;
      login.mockRestore();
    }
  });

  it('logs out only the original SID, tolerates disconnect failure, and allows repeated logout', async () => {
    const user = await owner();
    const other = await user.login();
    const disconnect = jest
      .spyOn(app.get(RealtimeConnectionsService), 'disconnectSessions')
      .mockImplementation(() => {
        throw new Error('disconnect failed');
      });
    try {
      await request(server)
        .post('/api/v1/auth/logout')
        .set('Cookie', user.cookie)
        .expect(200);
      expect(
        await prisma.userSession.findUnique({ where: { sid: user.sid } }),
      ).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.userId } }))
          .authVersion,
      ).toBe(1);
      expect(disconnect).toHaveBeenCalledWith([user.sid]);
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', user.cookie)
        .expect(401);
      await request(server)
        .get('/api/v1/auth/me')
        .set('Cookie', other.cookie)
        .expect(200);
      expect(await realtimeAccepts(other.cookie)).toBe(true);
      await request(server)
        .post('/api/v1/auth/logout')
        .set('Cookie', user.cookie)
        .expect(200);
    } finally {
      disconnect.mockRestore();
    }
  });

  it.each([
    'legacy',
    'missing',
    'string',
    'negative',
    'fractional',
    'mismatch',
  ])('rejects %s session versions over HTTP and realtime', async (kind) => {
    const user = await owner();
    const snapshots: Record<string, unknown> = {
      legacy: user.userId,
      missing: { id: user.userId },
      string: { id: user.userId, authVersion: '1' },
      negative: { id: user.userId, authVersion: -1 },
      fractional: { id: user.userId, authVersion: 1.5 },
      mismatch: { id: user.userId, authVersion: 2 },
    };
    await prisma.$executeRaw`UPDATE user_sessions SET sess = jsonb_set(sess::jsonb, '{passport,user}', ${JSON.stringify(snapshots[kind])}::jsonb)::json WHERE sid = ${user.sid}`;
    expect(await realtimeAccepts(user.cookie)).toBe(false);
    await request(server)
      .get('/api/v1/auth/me')
      .set('Cookie', user.cookie)
      .expect(401);
  });

  const cases: {
    mode: Mode;
    recreated: boolean;
    operations: string[];
    saves: number;
    touches: number;
  }[] = [
    {
      mode: 'unchanged',
      recreated: false,
      operations: ['touch'],
      saves: 0,
      touches: 1,
    },
    {
      mode: 'modified',
      recreated: true,
      operations: ['set'],
      saves: 1,
      touches: 1,
    },
    {
      mode: 'explicit-save',
      recreated: true,
      operations: ['set', 'touch'],
      saves: 1,
      touches: 1,
    },
    {
      mode: 'modified-explicit-save',
      recreated: true,
      operations: ['set', 'touch'],
      saves: 1,
      touches: 1,
    },
    {
      mode: 'touch',
      recreated: false,
      operations: ['touch'],
      saves: 0,
      touches: 2,
    },
    {
      mode: 'store-touch',
      recreated: false,
      operations: ['touch', 'touch'],
      saves: 0,
      touches: 1,
    },
  ];

  it.each(cases)(
    '$mode: characterizes the exact SID after an in-flight request finishes',
    async (scenario) => {
      const email = `${randomUUID()}@session-consistency.test`;
      const password = 'OriginalPass123!';
      const registered = await request(server)
        .post('/api/v1/auth/register')
        .send({
          name: 'Session consistency',
          email,
          password,
          role: 'applicant',
          acceptedTerms: true,
          acceptedPrivacy: true,
        })
        .expect(201);
      const userId = objectBody(registered)['id'];
      expect(typeof userId).toBe('string');
      const loggedIn = await request(server)
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);
      const headers: unknown = loggedIn.headers['set-cookie'];
      if (!Array.isArray(headers)) throw new Error('Missing login cookie');
      const cookie = headers
        .find(
          (value: unknown): value is string =>
            typeof value === 'string' && value.startsWith('sid='),
        )
        ?.split(';')[0];
      if (!cookie) throw new Error('Missing sid cookie');
      const sid = infrastructure.signedSessionId(cookie);
      if (!sid) throw new Error('Missing signed session id');
      const original = await prisma.userSession.findUniqueOrThrow({
        where: { sid },
      });
      expect(original.sess).toMatchObject({
        passport: { user: { id: userId, authVersion: 1 } },
      });
      const key = randomUUID();
      const gate: Gate = {
        mode: scenario.mode,
        loaded: deferred(),
        finish: deferred(),
      };
      gates.set(key, gate);
      const pending = request(server)
        .get('/__session_consistency_hold')
        .query({ key })
        .set('Cookie', cookie)
        .then((response) => response);
      await gate.loaded.promise;
      const loaded = gate.request;
      if (!loaded) throw new Error('Missing loaded request');
      expect(loaded.sessionID).toBe(sid);
      expect(loaded.user).toMatchObject({ id: userId });
      const store = loaded.sessionStore;
      const set = jest.spyOn(store, 'set');
      const touch = jest.spyOn(store, 'touch');
      try {
        const token = randomUUID();
        await prisma.passwordResetToken.create({
          data: {
            userId: String(userId),
            tokenHash: createHash('sha256').update(token).digest('hex'),
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        await app
          .get(AuthService)
          .resetPassword({ token, password: 'ResetPass456!' });
        expect(
          await prisma.userSession.findUnique({ where: { sid } }),
        ).toBeNull();
        await request(server)
          .get('/api/v1/auth/me')
          .set('Cookie', cookie)
          .expect(401);
        expect(await realtimeAccepts(cookie)).toBe(false);
        set.mockClear();
        touch.mockClear();
        gate.finish.release();
        expect((await pending).status).toBe(200);
        const operations = [
          ...set.mock.calls.map(([id], index) => ({
            id,
            method: 'set',
            order: set.mock.invocationCallOrder[index],
          })),
          ...touch.mock.calls.map(([id], index) => ({
            id,
            method: 'touch',
            order: touch.mock.invocationCallOrder[index],
          })),
        ]
          .filter((entry) => entry.id === sid)
          .sort((a, b) => a.order - b.order)
          .map((entry) => entry.method);
        expect(operations).toEqual(scenario.operations);
        expect(gate.lifecycle?.()).toEqual({
          save: scenario.saves,
          touch: scenario.touches,
        });
        const final = await prisma.userSession.findUnique({ where: { sid } });
        if (scenario.recreated) {
          expect(final?.sid).toBe(sid);
          expect(final?.sess).toMatchObject({
            passport: { user: { id: userId, authVersion: 1 } },
          });
        } else expect(final).toBeNull();
        // Check realtime before HTTP deserialization can strip stale Passport data.
        expect(await realtimeAccepts(cookie)).toBe(false);
        await expect(connectedSocket(cookie)).rejects.toMatchObject({
          data: { code: 'AUTH_REQUIRED' },
        });
        const next = await request(server)
          .get('/api/v1/auth/me')
          .set('Cookie', cookie);
        expect(next.status).toBe(401);
        expect(await realtimeAccepts(cookie)).toBe(false);
        expect(
          (
            await prisma.user.findUniqueOrThrow({
              where: { id: String(userId) },
            })
          ).authVersion,
        ).toBe(2);
        const fresh = await request(server)
          .post('/api/v1/auth/login')
          .send({ email, password: 'ResetPass456!' })
          .expect(200);
        const freshCookies: unknown = fresh.headers['set-cookie'];
        if (!Array.isArray(freshCookies) || typeof freshCookies[0] !== 'string')
          throw new Error('Missing new session');
        const freshCookie = freshCookies[0].split(';')[0];
        await request(server)
          .get('/api/v1/auth/me')
          .set('Cookie', freshCookie)
          .expect(200);
        expect(await realtimeAccepts(freshCookie)).toBe(true);
      } finally {
        gate.finish.release();
        await pending;
        set.mockRestore();
        touch.mockRestore();
        gates.delete(key);
      }
    },
  );
});
