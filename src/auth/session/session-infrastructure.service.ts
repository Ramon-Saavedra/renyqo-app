import {
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { parse } from 'cookie';
import { unsign } from 'cookie-signature';
import { Pool } from 'pg';
import { NodeEnv } from '../../config/env.validation';
import { PrismaService } from '../../prisma/prisma.service';
import type { SafeUser } from '../../users/types/safe-user.type';

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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.secret = config.getOrThrow<string>('SESSION_SECRET');
  }

  // Only login/registration may call this, after Passport saves its final generated SID.
  async establishGrant(sid: string, user: SafeUser): Promise<void> {
    const version = user.authVersion;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 2147483647
    )
      throw new UnauthorizedException('Session establishment failed');
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO session_auth_grants (sid, user_id, auth_version)
      SELECT s.sid, u.id, u.auth_version FROM user_sessions s
      JOIN users u ON u.id::text = s.sess->'passport'->'user'->>'id'
      WHERE s.sid = ${sid} AND s.expire > CURRENT_TIMESTAMP
        AND u.id = ${user.id}::uuid AND u.status = 'active'
        AND u.auth_version = ${version}::integer
        AND s.sess::jsonb->'passport'->'user'->'authVersion' = to_jsonb(u.auth_version)
    `;
    if (inserted !== 1)
      throw new UnauthorizedException('Session establishment failed');
  }

  async revokeGrant(sid: string): Promise<void> {
    await this.prisma.sessionAuthGrant.deleteMany({ where: { sid } });
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
