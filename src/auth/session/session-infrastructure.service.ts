import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { parse } from 'cookie';
import { unsign } from 'cookie-signature';
import { Pool } from 'pg';
import { NodeEnv } from '../../config/env.validation';

const SESSION_COOKIE = 'sid';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class SessionInfrastructureService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionInfrastructureService.name);
  private readonly secret: string;
  private store: InstanceType<ReturnType<typeof connectPgSimple>> | undefined;
  private pool: Pool | undefined;
  private closing: Promise<void> | undefined;
  private readonly onPoolError = (): void => {
    this.logger.error({
      signal: 'SESSION_POOL_ERROR',
      message: 'Idle session database client failed',
    });
  };

  constructor(private readonly config: ConfigService) {
    this.secret = config.getOrThrow<string>('SESSION_SECRET');
  }

  createMiddleware() {
    if (this.store) throw new Error('Session middleware already initialized');
    const PgStore = connectPgSimple(session);
    this.pool = new Pool({
      connectionString: this.config.getOrThrow<string>('DATABASE_URL'),
    });
    this.attachPoolErrorHandler(this.pool);
    this.store = new PgStore({
      pool: this.pool,
      tableName: 'user_sessions',
      createTableIfMissing: false,
    });
    return session({
      name: SESSION_COOKIE,
      secret: this.secret,
      resave: false,
      saveUninitialized: false,
      store: this.store,
      cookie: {
        httpOnly: true,
        secure: this.config.get<string>('NODE_ENV') === NodeEnv.Production,
        sameSite: 'lax',
        maxAge: SESSION_LIFETIME_MS,
      },
    });
  }

  signedSessionId(header: string | undefined): string | null {
    if (!header) return null;
    const cookie = parse(header)[SESSION_COOKIE];
    if (!cookie?.startsWith('s:')) return null;
    const id = unsign(cookie.slice(2), this.secret);
    return id || null;
  }

  async onModuleDestroy(): Promise<void> {
    this.closing ??= this.shutdown();
    await this.closing;
  }

  private attachPoolErrorHandler(pool: Pool): void {
    if (pool.listeners('error').includes(this.onPoolError)) return;
    pool.on('error', this.onPoolError);
  }

  private async shutdown(): Promise<void> {
    await Promise.resolve(this.store?.close());
    await this.pool?.end();
  }
}
