import { ConfigService } from '@nestjs/config';
import { SecurityLinkPolicy } from './security-link-policy';
describe('Focused security-link operational policy', () => {
  it('uses bounded issuance windows and fixed configured frontend paths', () => {
    const policy = new SecurityLinkPolicy(
      new ConfigService({ FRONTEND_URL: 'https://frontend.example/nested/' }),
    );
    expect(policy.invitationTtl).toBe(86400);
    expect(policy.verificationTtl).toBe(1800);
    expect(policy.resendCooldown).toBe(60);
    expect(policy.verificationCooldown).toBe(60);
    const url = new URL(policy.link('/workspace-invitation', 'opaque'));
    expect(url.origin).toBe('https://frontend.example');
    expect(url.pathname).toBe('/workspace-invitation');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=opaque');
  });
  it('rejects invalid operational configuration instead of silently widening expiry', () => {
    for (const value of ['NaN', '0', '604801', '1.5'])
      expect(
        () =>
          new SecurityLinkPolicy(
            new ConfigService({ INVITATION_TTL_SECONDS: value }),
          ).invitationTtl,
      ).toThrow('Invalid INVITATION_TTL_SECONDS');
  });
});
