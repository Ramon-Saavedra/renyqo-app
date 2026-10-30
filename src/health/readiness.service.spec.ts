import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Logger } from '@nestjs/common';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

type FakePool = {
  options: {
    connectionString?: string;
    max: number;
    connectionTimeoutMillis: number;
    query_timeout: number;
    statement_timeout: number;
  };
  query: jest.Mock<(text: string) => Promise<unknown>>;
  end: jest.Mock<() => Promise<void>>;
  on: jest.Mock<(event: string, listener: (error: Error) => void) => void>;
};

jest.mock('pg', () => {
  const createdPools: FakePool[] = [];
  const query = jest.fn<(text: string) => Promise<unknown>>();
  class RecordingPool {
    options: FakePool['options'];
    query = query;
    end: FakePool['end'];
    on: FakePool['on'];

    constructor(options: FakePool['options']) {
      this.options = options;
      this.end = jest.fn<() => Promise<void>>(() => Promise.resolve());
      this.on = jest.fn();
      createdPools.push(this);
    }
  }
  return { Pool: RecordingPool, createdPools, query };
});

function createdPools(): FakePool[] {
  return jest.requireMock<{ createdPools: FakePool[] }>('pg').createdPools;
}

function queryMock(): FakePool['query'] {
  return jest.requireMock<{ query: FakePool['query'] }>('pg').query;
}

describe('ReadinessService', () => {
  const databaseUrl = 'postgres://readiness:secret@db.internal:5432/renyqo';
  let previousDatabaseUrl: string | undefined;
  const error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = databaseUrl;
    createdPools().length = 0;
    queryMock().mockReset();
    queryMock().mockResolvedValue({ rows: [] });
    error.mockClear();
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = previousDatabaseUrl;
    }
    jest.useRealTimers();
  });

  it('opens one readiness pool with bounded timeouts', async () => {
    const service = new ReadinessService();

    await expect(service.check()).resolves.toBe('ok');

    expect(createdPools()).toHaveLength(1);
    expect(createdPools()[0]?.options).toEqual({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      query_timeout: 1000,
      statement_timeout: 1000,
    });
    expect(READINESS_TIMEOUT_MS).toBe(1000);
  });

  it('returns ok after SELECT 1', async () => {
    const service = new ReadinessService();

    await expect(service.check()).resolves.toBe('ok');

    expect(queryMock()).toHaveBeenCalledTimes(1);
    expect(queryMock()).toHaveBeenCalledWith('SELECT 1');
    expect(error).not.toHaveBeenCalled();
  });

  it('returns unavailable and logs only the fixed signal when the query fails', async () => {
    queryMock().mockRejectedValueOnce(
      new Error('connect ECONNREFUSED secret-host:5432'),
    );
    const service = new ReadinessService();

    await expect(service.check()).resolves.toBe('unavailable');

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ signal: 'READINESS_CHECK_FAILED' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-host');
    expect(JSON.stringify(error.mock.calls)).not.toContain('SELECT');
    expect(JSON.stringify(error.mock.calls)).not.toContain(databaseUrl);

    const pool = createdPools()[0];
    const onError = pool?.on.mock.calls.find(
      (call) => call[0] === 'error',
    )?.[1];
    onError?.(new Error('password authentication failed for user secret-host'));
    expect(error).toHaveBeenLastCalledWith({
      signal: 'READINESS_CHECK_FAILED',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-host');
    expect(JSON.stringify(error.mock.calls)).not.toContain('password');
  });

  it('shares one in-flight query across concurrent probes', async () => {
    let resolveQuery: ((value: unknown) => void) | undefined;
    queryMock().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const service = new ReadinessService();

    const first = service.check();
    const second = service.check();

    expect(queryMock()).toHaveBeenCalledTimes(1);
    resolveQuery?.({ rows: [] });
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(queryMock()).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('clears a failed probe and lets the next check query again', async () => {
    queryMock()
      .mockRejectedValueOnce(new Error('Query read timeout'))
      .mockResolvedValueOnce({ rows: [] });
    const service = new ReadinessService();

    await expect(service.check()).resolves.toBe('unavailable');
    await expect(service.check()).resolves.toBe('ok');

    expect(queryMock()).toHaveBeenCalledTimes(2);
    expect(queryMock()).toHaveBeenNthCalledWith(1, 'SELECT 1');
    expect(queryMock()).toHaveBeenNthCalledWith(2, 'SELECT 1');
  });

  it('ends the readiness pool on shutdown without waiting forever', async () => {
    const service = new ReadinessService();
    await service.check();
    const pool = createdPools()[0];
    if (!pool) throw new Error('readiness pool was not created');

    await service.onModuleDestroy();
    expect(pool.end).toHaveBeenCalledTimes(1);

    const replacement = new ReadinessService();
    await replacement.check();
    const hanging = createdPools().at(-1);
    if (!hanging) throw new Error('replacement readiness pool was not created');
    hanging.end.mockImplementation(() => new Promise<void>(() => undefined));
    jest.useFakeTimers();
    const finished = replacement.onModuleDestroy();
    const settled = jest.fn();
    void finished.then(settled);
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    expect(hanging.end).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
