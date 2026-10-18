import { ConfigService } from '@nestjs/config';
import { NodeEnv } from '../config/env.validation';
import { OutboxConfigService } from './outbox-config.service';

describe('OutboxConfigService', () => {
  it('defaults dispatch to disabled', () => {
    const config = new OutboxConfigService(new ConfigService({}));
    expect(config.dispatchEnabled).toBe(false);
  });

  it('rejects dispatch enabled in production on module init', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = NodeEnv.Production;
    const config = new OutboxConfigService(
      new ConfigService({ OUTBOX_DISPATCH_ENABLED: 'true' }),
    );
    expect(() => config.onModuleInit()).toThrow(/OUTBOX_DISPATCH_ENABLED/);
    process.env['NODE_ENV'] = previous;
  });
});
