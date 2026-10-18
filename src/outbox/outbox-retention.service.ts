import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OutboxConfigService } from './outbox-config.service';
import { OutboxRepository } from './outbox-repository';

@Injectable()
export class OutboxRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRetentionService.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly config: OutboxConfigService,
    private readonly repository: OutboxRepository,
  ) {}

  onModuleInit(): void {
    this.stopped = false;
    if (process.env['NODE_ENV'] === 'test') return;
    this.schedule(60_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run();
    }, delayMs);
  }

  async run(): Promise<number> {
    try {
      const cutoff = new Date(
        Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000,
      );
      let total = 0;
      for (;;) {
        const deleted = await this.repository.deleteDispatchedOlderThan(
          cutoff,
          this.config.retentionBatchSize,
        );
        total += deleted;
        if (deleted < this.config.retentionBatchSize) break;
      }
      if (total > 0) {
        this.logger.log({ signal: 'OUTBOX_RETENTION_DELETED', count: total });
      }
      return total;
    } catch (error) {
      this.logger.error({
        signal: 'OUTBOX_RETENTION_RUN_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.schedule(24 * 60 * 60 * 1000);
    }
  }
}
