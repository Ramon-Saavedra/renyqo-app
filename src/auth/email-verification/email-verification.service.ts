import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializableTransaction } from '../../prisma/run-serializable-transaction';
import type { Prisma } from '../../generated/prisma/client';
import type { SessionAuthority } from '../../provider-authorization/domain/authorization.types';
import { GlobalAuthorityReader } from '../../provider-authorization/persistence/global-authority.reader';
import { EmailService } from '../../email/email.service';
import { issueSecret, hashSecret } from '../../security/opaque-secret';
import { SecurityLinkPolicy } from '../../security/security-link-policy';

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly global: GlobalAuthorityReader,
    private readonly email: EmailService,
    private readonly policy: SecurityLinkPolicy,
  ) {}
  private run<T>(
    a: SessionAuthority,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${a.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT sid FROM session_auth_grants WHERE sid=${a.sessionId} FOR SHARE`;
      await this.global.assert(tx, a);
      return work(tx);
    });
  }
  async request(a: SessionAuthority) {
    this.email.assertSecurityDeliveryConfigured();
    const token = issueSecret('email-verification'),
      id = randomUUID();
    const result = await this.run(a, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: a.userId } });
      if (user.emailVerified) return { verified: true, email: user.email };
      const [clock] = await tx.$queryRaw<
        { now: Date; limited: boolean }[]
      >`SELECT clock_timestamp() AS now,EXISTS(SELECT FROM email_verification_challenges WHERE user_id=${a.userId}::uuid AND created_at>clock_timestamp()-make_interval(secs=>${this.policy.verificationCooldown}::integer)) AS limited`;
      if (clock.limited)
        throw new HttpException(
          {
            code: 'EMAIL_VERIFICATION_RATE_LIMITED',
            message: 'Try again later',
          },
          429,
        );
      await tx.emailVerificationChallenge.updateMany({
        where: { userId: a.userId, usedAt: null },
        data: { usedAt: clock.now },
      });
      await tx.emailVerificationChallenge.create({
        data: {
          id,
          userId: a.userId,
          email: user.email,
          tokenHash: token.hash,
          authVersion: a.authVersion,
          sessionId: a.sessionId,
          expiresAt: new Date(
            clock.now.getTime() + this.policy.verificationTtl * 1000,
          ),
        },
      });
      await this.global.assertSession(tx, a);
      return { verified: false, email: user.email };
    });
    if (result.verified) return { verified: true, delivery: 'NOT_REQUIRED' };
    try {
      await this.email.sendSecurityLink({
        to: result.email,
        subject: 'Verify your Renyqo email',
        text: 'Verify the email of your authenticated Renyqo account.',
        label: 'Verify email',
        url: this.policy.link('/verify-email', token.secret),
      });
      return { verified: false, delivery: 'ACCEPTED' };
    } catch {
      return { verified: false, delivery: 'FAILED' };
    }
  }
  confirm(a: SessionAuthority, secret: string) {
    const hash = hashSecret('email-verification', secret);
    return this.run(a, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; email: string; expires_at: Date }[]
      >`SELECT id,email,expires_at FROM email_verification_challenges WHERE token_hash=${hash} AND user_id=${a.userId}::uuid AND session_id=${a.sessionId} AND auth_version=${a.authVersion} AND used_at IS NULL FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: a.userId } });
      const [{ now }] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      if (!rows[0] || rows[0].email !== user.email || rows[0].expires_at <= now)
        throw new BadRequestException({
          code: 'EMAIL_VERIFICATION_UNAVAILABLE',
          message: 'Verification unavailable',
        });
      await this.global.assertSession(tx, a);
      await tx.emailVerificationChallenge.update({
        where: { id: rows[0].id },
        data: { usedAt: now },
      });
      await tx.user.update({
        where: { id: a.userId },
        data: { emailVerified: true },
      });
      return { verified: true };
    });
  }
}
