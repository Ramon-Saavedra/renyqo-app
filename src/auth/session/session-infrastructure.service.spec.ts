import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { SessionInfrastructureService } from './session-infrastructure.service';

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

  function service(): SessionInfrastructureService {
    return new SessionInfrastructureService(
      new ConfigService({
        SESSION_SECRET: 'session-secret-at-least-32-characters',
        DATABASE_URL: databaseUrl,
        NODE_ENV: 'test',
      }),
    );
  }

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

  it('closes the shared pool once during shutdown', async () => {
    const infrastructure = service();
    infrastructure.createMiddleware();
    const pool = createdPools()[0];
    const end = jest.spyOn(pool, 'end');

    await infrastructure.onModuleDestroy();
    await infrastructure.onModuleDestroy();

    expect(end).toHaveBeenCalledTimes(1);
    expect(pool.listenerCount('error')).toBe(1);
    await expect(pool.end()).rejects.toThrow(/more than once/);
  });
});
