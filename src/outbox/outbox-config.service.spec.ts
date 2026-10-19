import { ConfigService } from '@nestjs/config';
import { OutboxConfigService } from './outbox-config.service';

describe('OutboxConfigService', () => {
  it('defaults dispatch to disabled', () => {
    const config = new OutboxConfigService(new ConfigService({}));
    expect(config.dispatchEnabled).toBe(false);
  });

  it('rejects dispatch without enabled realtime on module init', () => {
    const config = new OutboxConfigService(
      new ConfigService({ OUTBOX_DISPATCH_ENABLED: 'true' }),
    );
    expect(() => config.onModuleInit()).toThrow(/OUTBOX_DISPATCH_ENABLED/);
  });
});
