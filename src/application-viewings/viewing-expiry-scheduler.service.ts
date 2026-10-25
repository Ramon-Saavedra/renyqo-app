import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ViewingWorkflowExpiryService } from './viewing-workflow-expiry.service';

@Injectable()
export class ViewingExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ViewingExpiryScheduler.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private inFlight?: Promise<void>;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
  constructor(
    config: ConfigService,
    private readonly expiry: ViewingWorkflowExpiryService,
  ) {
    const enabled = config.get<string>('VIEWING_EXPIRY_ENABLED');
    if (enabled !== undefined && !['true', 'false'].includes(enabled))
      throw new Error('VIEWING_EXPIRY_ENABLED must be true or false');
    this.enabled =
      enabled === undefined
        ? (config.get<string>('NODE_ENV') ?? process.env.NODE_ENV) !== 'test'
        : enabled === 'true';
    this.intervalMs = integer(
      config.get<string>('VIEWING_EXPIRY_INTERVAL_MS'),
      30000,
      1000,
      3600000,
    );
    this.batchSize = integer(
      config.get<string>('VIEWING_EXPIRY_BATCH_SIZE'),
      50,
      1,
      500,
    );
  }
  onModuleInit() {
    if (!this.enabled) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delay);
    this.timer.unref();
  }
  private async tick() {
    try {
      await this.expiry.runOnce(this.batchSize);
    } catch {
      this.logger.error({ signal: 'VIEWING_EXPIRY_POLL_FAILED' });
    } finally {
      this.schedule(this.intervalMs);
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    parsed > max
  )
    throw new Error(
      `Viewing expiry configuration must be an integer between ${min} and ${max}`,
    );
  return parsed;
}
