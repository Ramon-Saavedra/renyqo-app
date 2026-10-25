import { ConfigService } from '@nestjs/config';
import { ViewingExpiryScheduler } from './viewing-expiry-scheduler.service';
import type { ViewingWorkflowExpiryService } from './viewing-workflow-expiry.service';

describe('Viewing expiry scheduler', () => {
  afterEach(() => jest.useRealTimers());
  const service = (
    values: Record<string, string | undefined> = {},
    runOnce = jest.fn(),
  ) =>
    new ViewingExpiryScheduler(
      new ConfigService({ NODE_ENV: 'test', ...values }),
      { runOnce } as unknown as ViewingWorkflowExpiryService,
    );

  it('disables automatic scheduling in tests and validates bounded operational settings', () => {
    const s = service();
    expect(s.enabled).toBe(false);
    expect(s.intervalMs).toBe(30000);
    expect(s.batchSize).toBe(50);
    expect(service({ NODE_ENV: 'production' }).enabled).toBe(true);
    for (const values of [
      { VIEWING_EXPIRY_ENABLED: 'yes' },
      { VIEWING_EXPIRY_INTERVAL_MS: '0' },
      { VIEWING_EXPIRY_BATCH_SIZE: '501' },
      { VIEWING_EXPIRY_BATCH_SIZE: '1.5' },
    ])
      expect(() => service(values)).toThrow();
  });
  it('scans immediately, retries failed polls, never overlaps, and stops cleanly', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(undefined);
    const s = service({ VIEWING_EXPIRY_ENABLED: 'true' }, run);
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(90000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(30000);
    expect(run).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30000);
    expect(run).toHaveBeenCalledTimes(3);
    await s.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
