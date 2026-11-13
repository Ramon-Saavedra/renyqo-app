import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { EventEmitter } from 'node:events';
import { sign } from 'cookie-signature';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { SessionInfrastructureService } from './session-infrastructure.service';
import { PrismaService } from '../../prisma/prisma.service';

jest.mock('pg', () => {
  const actual = jest.requireActual<typeof import('pg')>('pg');
  const createdPools: Pool[] = [];
  class RecordingPool extends actual.Pool {
    constructor(...args: ConstructorParameters<typeof actual.Pool>) {
      super(...args);
      createdPools.push(this);
    }
  }
  return { ...actual, Pool: RecordingPool, createdPools };
});

function createdPools(): Pool[] {
  return jest.requireMock<{ createdPools: Pool[] }>('pg').createdPools;
}

describe('Session pool errors', () => {
  const databaseUrl =
    'postgres://session-user:session-password@db.internal:5432/renyqo';
  let logged: unknown[];

  beforeEach(() => {
    logged = [];
    createdPools().length = 0;
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message) => {
      logged.push(message);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      createdPools().map(async (pool) => {
        try {
          await pool.end();
        } catch {
          // Shutdown coverage ends the pool once; a second end is expected to fail.
        }
      }),
    );
  });

  function service(
    pool = new Pool({ connectionString: databaseUrl }),
  ): SessionInfrastructureService {
    return new SessionInfrastructureService(
      new ConfigService({
        SESSION_SECRET: 'session-secret-at-least-32-characters',
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
      }),
      {
        getSharedPool: () => pool,
        getDatabaseSchema: () => 'public',
      } as PrismaService,
    );
  }

  it('reads an encoded signed SID among other cookies with the cookie v2 parser', () => {
    const sid = 'session-id.with-punctuation';
    const signed = sign(sid, 'session-secret-at-least-32-characters');
    expect(
      service().signedSessionId(
        `theme=dark; sid=${encodeURIComponent(`s:${signed}`)}; locale=de`,
      ),
    ).toBe(sid);
  });

  it.each([undefined, '', 'theme=dark', 'sid=unsigned', 'sid=s%3Atampered'])(
    'rejects absent, unsigned or invalid session cookies: %s',
    (header) => {
      expect(service().signedSessionId(header)).toBeNull();
    },
  );

  it('handles an idle pool error once when the shared pool is created', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('idle client failed'))).toThrow(
      'idle client failed',
    );

    const infrastructure = service();
    infrastructure.createMiddleware();
    const pool = createdPools()[0];
    expect(pool).toBeInstanceOf(Pool);
    expect(pool.listenerCount('error')).toBe(1);

    const leaked =
      'postgres://session-user:session-password@db.internal/renyqo sid=session-id cookie=sid';
    expect(() => pool.emit('error', new Error(leaked))).not.toThrow();
    expect(() => infrastructure.createMiddleware()).toThrow(
      'Session middleware already initialized',
    );
    expect(createdPools()).toHaveLength(1);
    expect(pool.listenerCount('error')).toBe(1);
    expect(logged).toEqual([
      {
        signal: 'SESSION_POOL_ERROR',
        message: 'Idle session database client failed',
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('session-password');
    expect(JSON.stringify(logged)).not.toContain('session-id');
    expect(JSON.stringify(logged)).not.toContain('cookie');
  });

  it('closes only the store while Prisma owns the shared pool', async () => {
    const infrastructure = service();
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    infrastructure.createMiddleware();
    const pool = createdPools()[0];
    const store = (
      infrastructure as unknown as {
        store?: { close: () => Promise<void> };
      }
    ).store;
    if (store) store.close = close;
    const end = jest.spyOn(pool, 'end');

    await infrastructure.onModuleDestroy();
    await infrastructure.onModuleDestroy();

    expect(close).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
  });
});
