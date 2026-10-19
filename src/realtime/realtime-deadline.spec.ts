import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  REALTIME_OPERATION_TIMEOUT_MS,
  withRealtimeDeadline,
} from './realtime-deadline';

describe('withRealtimeDeadline', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not leave a late rejection unhandled after a timeout', async () => {
    jest.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const result = expect(
      withRealtimeDeadline(async (signal) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, REALTIME_OPERATION_TIMEOUT_MS + 1000);
        });
        if (signal.aborted) throw new Error('Realtime publication cancelled');
        return 'late';
      }),
    ).rejects.toThrow('Realtime operation timed out');

    await jest.advanceTimersByTimeAsync(REALTIME_OPERATION_TIMEOUT_MS);
    await result;
    await jest.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
