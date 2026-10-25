import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationRetention implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inFlight?: Promise<void>;
  private readonly logger = new Logger(NotificationRetention.name);
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() {
    if (process.env.NODE_ENV !== 'test') this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, 60000);
    this.timer.unref();
  }
  async purgeExpired() {
    return this.prisma.$executeRaw`DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at, id LIMIT 500
    )`;
  }
  private async tick() {
    try {
      await this.purgeExpired();
    } catch {
      this.logger.error({ signal: 'NOTIFICATION_RETENTION_FAILED' });
    } finally {
      this.schedule();
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}
