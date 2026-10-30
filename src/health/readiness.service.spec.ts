import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  const error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);

  afterEach(() => {
    error.mockClear();
    jest.useRealTimers();
  });

  function createService() {
    const queryRaw = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new ReadinessService({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    return { queryRaw, service };
  }

  it('returns ok after SELECT 1', async () => {
    const { queryRaw, service } = createService();
    queryRaw.mockResolvedValue([{ result: 1 }]);

    await expect(service.check()).resolves.toBe('ok');
    expect(error).not.toHaveBeenCalled();
  });

  it('returns unavailable and logs a fixed signal when the query fails', async () => {
    const { queryRaw, service } = createService();
    queryRaw.mockRejectedValue(
      new Error('connect ECONNREFUSED secret-host:5432'),
    );

    await expect(service.check()).resolves.toBe('unavailable');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ signal: 'READINESS_CHECK_FAILED' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret-host');
  });

  it('times out one shared query without starting another', async () => {
    jest.useFakeTimers();
    const { queryRaw, service } = createService();
    queryRaw.mockImplementation(() => new Promise(() => undefined));

    const first = service.check();
    const second = service.check();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await expect(first).resolves.toBe('unavailable');
    await expect(second).resolves.toBe('unavailable');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ signal: 'READINESS_CHECK_FAILED' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('SELECT');
  });
});
