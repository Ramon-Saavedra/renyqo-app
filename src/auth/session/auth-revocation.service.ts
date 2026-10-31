import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeConnectionsService } from '../../realtime/realtime-connections.service';

type Revocation = { authVersion: number; sessionIds: string[] };

@Injectable()
export class AuthRevocationService {
  private readonly logger = new Logger(AuthRevocationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: RealtimeConnectionsService,
  ) {}

  // Call inside the caller's credential/account transaction. No external side effects.
  async revokeAll(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<Revocation> {
    const user = await tx.user.update({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
      select: { authVersion: true },
    });
    const sessions = await tx.$queryRaw<{ sid: string }[]>`
      SELECT sid FROM user_sessions
      WHERE (sess->'passport'->'user'->>'id' = ${userId}
        OR sess->'passport'->>'user' = ${userId})
        AND sess::jsonb->'passport'->'user'->'authVersion' IS DISTINCT FROM to_jsonb(${user.authVersion}::integer)
    `;
    return {
      authVersion: user.authVersion,
      sessionIds: sessions.map(({ sid }) => sid),
    };
  }

  // Only call after commit. Failure cannot change the durable revocation result.
  async cleanup(revocation: Revocation): Promise<void> {
    if (revocation.sessionIds.length === 0) return;
    try {
      await this.prisma.$executeRaw`
        DELETE FROM user_sessions WHERE sid = ANY(${revocation.sessionIds}::text[])
          AND sess::jsonb->'passport'->'user'->'authVersion' IS DISTINCT FROM to_jsonb(${revocation.authVersion}::integer)
      `;
    } catch {
      this.logger.warn({ signal: 'AUTH_SESSION_CLEANUP_FAILED' });
    }
    try {
      this.connections.disconnectSessions(revocation.sessionIds);
    } catch {
      this.logger.warn({ signal: 'AUTH_REALTIME_CLEANUP_FAILED' });
    }
  }
}
