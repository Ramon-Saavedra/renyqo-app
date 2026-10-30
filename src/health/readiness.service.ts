import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

export const READINESS_TIMEOUT_MS = 1000;

/**
 * Readiness uses its own one-connection pool. `pg` applies the connection,
 * statement, and query limits to that pool only. A timed-out client is removed,
 * so the next probe opens a new connection. `pool.end()` force-closes an active
 * query; shutdown still stops waiting after the readiness limit.
 */
@Injectable()
export class ReadinessService implements OnModuleDestroy {
  private readonly logger = new Logger(ReadinessService.name);
  private pool: Pool | null = null;
  private pending: Promise<void> | null = null;

  async check(): Promise<'ok' | 'unavailable'> {
    try {
      await (this.pending ?? this.start());
      return 'ok';
    } catch {
      this.logger.error({ signal: 'READINESS_CHECK_FAILED' });
      return 'unavailable';
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.pending = null;
    if (!pool) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READINESS_TIMEOUT_MS);
      void pool.end().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          this.logger.error({ signal: 'READINESS_CHECK_FAILED' });
          resolve();
        },
      );
    });
  }

  private start(): Promise<void> {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(this.database().query('SELECT 1')).then(
        () => undefined,
      );
    } catch (caught) {
      const failure =
        caught instanceof Error ? caught : new Error('Readiness query failed');
      pending = Promise.reject(failure);
    }
    this.pending = pending;
    const clear = (): void => {
      if (this.pending === pending) this.pending = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private database(): Pool {
    if (this.pool) return this.pool;
    const pool = new Pool({
      connectionString: process.env['DATABASE_URL'],
      max: 1,
      connectionTimeoutMillis: READINESS_TIMEOUT_MS,
      query_timeout: READINESS_TIMEOUT_MS,
      statement_timeout: READINESS_TIMEOUT_MS,
    });
    pool.on('error', () => {
      this.logger.error({ signal: 'READINESS_CHECK_FAILED' });
    });
    this.pool = pool;
    return pool;
  }
}
