import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type { HumanAuthority } from '../domain/authorization.types';

@Injectable()
export class GlobalAuthorityReader {
  assertFacts(
    authority: HumanAuthority,
    facts: {
      userStatus: string;
      authVersion: number;
      sessionValid: boolean;
    } | null,
  ): void {
    if (
      !facts ||
      facts.userStatus !== 'active' ||
      facts.authVersion !== authority.authVersion ||
      !facts.sessionValid
    )
      throw new UnauthorizedException();
  }
  async assert(
    tx: Prisma.TransactionClient,
    authority: HumanAuthority,
  ): Promise<void> {
    const [user] = await tx.$queryRaw<
      { status: string; auth_version: number }[]
    >`
      SELECT status::text, auth_version FROM users WHERE id=${authority.userId}::uuid`;
    if (
      !user ||
      user.status !== 'active' ||
      user.auth_version !== authority.authVersion
    )
      throw new UnauthorizedException();
    await this.assertSession(tx, authority);
  }

  async assertSession(
    tx: Prisma.TransactionClient,
    authority: HumanAuthority,
  ): Promise<void> {
    if (authority.mode !== 'SESSION_BOUND') return;
    const [grant] = await tx.$queryRaw<{ sid: string }[]>`
      SELECT g.sid FROM session_auth_grants g JOIN user_sessions s ON s.sid=g.sid
      WHERE g.sid=${authority.sessionId} AND g.user_id=${authority.userId}::uuid
        AND g.auth_version=${authority.authVersion}::integer AND s.expire > clock_timestamp()
        AND s.sess->'passport'->'user'->>'id'=${authority.userId}
        AND jsonb_typeof(s.sess::jsonb->'passport'->'user'->'authVersion')='number'
        AND s.sess::jsonb->'passport'->'user'->'authVersion'=to_jsonb(${authority.authVersion}::integer)`;
    if (!grant) throw new UnauthorizedException();
  }
}
