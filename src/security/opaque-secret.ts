import { createHash, randomBytes } from 'node:crypto';
export type SecretPurpose = 'workspace-invitation' | 'email-verification';
export function issueSecret(purpose: SecretPurpose) {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: hashSecret(purpose, secret) };
}
export function hashSecret(purpose: SecretPurpose, secret: string): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
    Buffer.from(secret, 'base64url').toString('base64url') !== secret
  )
    return createHash('sha256').update(`invalid:${purpose}`).digest('hex');
  return createHash('sha256')
    .update(`${purpose}:v1\0`)
    .update(Buffer.from(secret, 'base64url'))
    .digest('hex');
}
export function commandFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
