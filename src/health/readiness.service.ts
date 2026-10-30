import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const READINESS_TIMEOUT_MS = 1000;

/**
 * Prisma 7.9.1 and @prisma/adapter-pg run `pool.query()` with no cancel token.
 * Timing out this HTTP result does not cancel that query. A later probe joins
 * the same in-flight `SELECT 1` instead of starting another one.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  private pending: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<'ok' | 'unavailable'> {
    const pending = this.pending ?? this.start();
    const status = await this.finishWithin(pending);
    if (status === 'unavailable') {
      this.logger.error({ signal: 'READINESS_CHECK_FAILED' });
    }
    return status;
  }

  private start(): Promise<void> {
    const pending = this.prisma.$queryRaw`SELECT 1`.then(() => undefined);
    this.pending = pending;
    void pending.then(
      () => {
        if (this.pending === pending) this.pending = null;
      },
      () => {
        if (this.pending === pending) this.pending = null;
      },
    );
    return pending;
  }

  private async finishWithin(
    pending: Promise<void>,
  ): Promise<'ok' | 'unavailable'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => 'ok' as const),
        new Promise<'unavailable'>((resolve) => {
          timer = setTimeout(
            () => resolve('unavailable'),
            READINESS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      return 'unavailable';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
