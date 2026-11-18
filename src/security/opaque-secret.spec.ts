import { issueSecret, hashSecret, commandFingerprint } from './opaque-secret';
describe('Purpose-separated opaque security links', () => {
  it('generates independent 256-bit secrets with only hashes suitable for persistence', () => {
    const a = issueSecret('workspace-invitation'),
      b = issueSecret('workspace-invitation');
    expect(Buffer.from(a.secret, 'base64url')).toHaveLength(32);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(hashSecret('workspace-invitation', a.secret));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret('email-verification', a.secret)).not.toBe(a.hash);
  });
  it('never treats alternate base64 encodings as the issued secret', () => {
    const a = issueSecret('email-verification');
    expect(hashSecret('email-verification', `${a.secret}=`)).not.toBe(a.hash);
    expect(hashSecret('email-verification', '')).not.toBe(a.hash);
  });
  it('binds command fingerprints to the complete intended input', () => {
    expect(commandFingerprint(['CREATE', 'a'])).toBe(
      commandFingerprint(['CREATE', 'a']),
    );
    expect(commandFingerprint(['CREATE', 'a'])).not.toBe(
      commandFingerprint(['CREATE', 'b']),
    );
  });
});
