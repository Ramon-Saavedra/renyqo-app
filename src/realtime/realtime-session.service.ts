import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/enums';
import { SessionInfrastructureService } from '../auth/session/session-infrastructure.service';
import { withRealtimeDeadline } from './realtime-deadline';

export type RealtimeIdentity = {
  sessionId: string;
  userId: string;
  role: Role;
};
const SESSION_BATCH_SIZE = 200;

@Injectable()
export class RealtimeSessionService {
  constructor(
    private readonly sessions: SessionInfrastructureService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(cookie: string | undefined): Promise<RealtimeIdentity> {
    const id = this.sessions.signedSessionId(cookie);
    if (!id) throw new Error('Unauthenticated');
    const identity = (await this.valid([id])).get(id);
    if (!identity) throw new Error('Unauthenticated');
    return identity;
  }

  async valid(ids: readonly string[]): Promise<Map<string, RealtimeIdentity>> {
    return withRealtimeDeadline((signal) => this.load(ids, signal));
  }

  private async load(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, RealtimeIdentity>> {
    const distinct = [...new Set(ids)];
    const result = new Map<string, RealtimeIdentity>();
    for (
      let offset = 0;
      offset < distinct.length;
      offset += SESSION_BATCH_SIZE
    ) {
      if (signal.aborted) throw new Error('Session lookup cancelled');
      const rows = await this.prisma.$queryRaw<RealtimeIdentity[]>`
        SELECT s.sid AS "sessionId", u.id AS "userId", UPPER(u.role::text) AS role
        FROM user_sessions s JOIN users u
          ON u.id::text = s.sess->'passport'->>'user'
        WHERE s.sid = ANY(${distinct.slice(offset, offset + SESSION_BATCH_SIZE)}::text[])
          AND s.expire > CURRENT_TIMESTAMP
          AND u.status = 'active'
          AND u.role IN ('applicant', 'provider')
      `;
      for (const row of rows) {
        if (row.role === Role.APPLICANT || row.role === Role.PROVIDER)
          result.set(row.sessionId, row);
      }
    }
    return result;
  }
}
