import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class SecurityLinkPolicy {
  constructor(private readonly config: ConfigService) {}
  private seconds(name: string, fallback: number, min: number, max: number) {
    const n = Number(this.config.get<string>(name) ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  }
  get invitationTtl() {
    return this.seconds('INVITATION_TTL_SECONDS', 86400, 60, 604800);
  }
  get verificationTtl() {
    return this.seconds('EMAIL_VERIFICATION_TTL_SECONDS', 1800, 60, 86400);
  }
  get resendCooldown() {
    return this.seconds('INVITATION_RESEND_COOLDOWN_SECONDS', 60, 0, 3600);
  }
  get verificationCooldown() {
    return this.seconds('EMAIL_VERIFICATION_COOLDOWN_SECONDS', 60, 0, 3600);
  }
  link(path: '/workspace-invitation' | '/verify-email', secret: string) {
    const base =
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
    const u = new URL(path, base);
    u.hash = `token=${encodeURIComponent(secret)}`;
    return u.toString();
  }
}
