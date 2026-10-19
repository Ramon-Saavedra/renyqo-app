import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { RealtimeConfigService } from './realtime-config.service';
import { OutboxConfigService } from '../outbox/outbox-config.service';

describe('Realtime configuration', () => {
  it('defaults to disabled', () => {
    expect(new RealtimeConfigService(new ConfigService()).enabled).toBe(false);
  });
  it.each(['abc', '0', '-1', '2.5'])('rejects invalid limits: %s', (value) => {
    expect(
      () =>
        new RealtimeConfigService(
          new ConfigService({ REALTIME_MAX_CONNECTIONS: value }),
        ),
    ).toThrow();
  });
  it('requires an explicit frontend for enabled realtime', () => {
    expect(
      () =>
        new RealtimeConfigService(
          new ConfigService({ REALTIME_ENABLED: 'true' }),
        ),
    ).toThrow();
  });
  it.each([
    ['false', 'false', true],
    ['false', 'true', false],
    ['true', 'false', true],
    ['true', 'true', true],
  ])('checks realtime=%s and dispatch=%s', (realtime, dispatch, allowed) => {
    const outbox = new OutboxConfigService(
      new ConfigService({
        REALTIME_ENABLED: realtime,
        OUTBOX_DISPATCH_ENABLED: dispatch,
      }),
    );
    if (allowed) expect(() => outbox.onModuleInit()).not.toThrow();
    else expect(() => outbox.onModuleInit()).toThrow();
  });
});
