import { randomUUID } from 'node:crypto';
import { validateAuditEvent } from './audit-payload';

function valid() {
  const workspaceId = randomUUID();
  return {
    id: randomUUID(),
    workspaceId,
    action: 'audit.ledger.activated',
    schemaVersion: 1,
    actor: { kind: 'SYSTEM', purpose: 'AUDIT_LEDGER_ACTIVATION' },
    resourceType: 'WORKSPACE',
    resourceId: workspaceId,
    occurredAt: new Date().toISOString(),
    source: 'INTERNAL',
    correlationId: randomUUID(),
    commandId: randomUUID(),
    commandScope: 'audit.ledger.activation',
    effectKey: 'activation',
    changes: {},
    metadata: { activationVersion: 1 },
  };
}
describe('Closed audit foundation payload contract', () => {
  it('accepts its exact versioned contract', () => {
    const event = valid();
    expect(validateAuditEvent(event)).toBe(event);
  });
  it.each([
    'password',
    'sessionId',
    'cookie',
    'authToken',
    'invitationSecret',
    'tokenHash',
    'signedUrl',
    'storageCredentials',
    'documentBytes',
    'body',
    'profile',
    'request',
    'exception',
  ])('rejects %s at every extension boundary', (field) => {
    const event = valid();
    for (const input of [
      { ...event, [field]: 'forbidden' },
      { ...event, metadata: { ...event.metadata, [field]: 'forbidden' } },
      { ...event, changes: { [field]: 'forbidden' } },
      { ...event, actor: { ...event.actor, [field]: 'forbidden' } },
    ])
      expect(() => validateAuditEvent(input)).toThrow(
        'Invalid audit event contract',
      );
  });
  it.each([
    { schemaVersion: 2 },
    { action: 'listing.changed' },
    { actor: { kind: 'INTEGRATION' } },
    { source: 'HTTP' },
    { actor: { kind: 'SYSTEM' } },
    { changes: [] },
    { metadata: null },
    { metadata: { activationVersion: 1, unknown: true } },
    { metadata: { activationVersion: '1' } },
    { listingId: randomUUID() },
    { resourceRevisionAfter: 1 },
    { occurredAt: 'infinity' },
    { sourceEvidenceType: 'anything' },
    { commandId: 'invalid' },
    { metadata: { activationVersion: 1, body: 'x'.repeat(8193) } },
  ])('rejects invalid shape/version/types', (patch) => {
    expect(() => validateAuditEvent({ ...valid(), ...patch })).toThrow(
      TypeError,
    );
  });
  it('accepts typed user/member references, without treating them as authority', () => {
    for (const actor of [
      { kind: 'USER', userId: randomUUID() },
      { kind: 'MEMBER', userId: randomUUID(), membershipId: randomUUID() },
    ])
      expect(() => validateAuditEvent({ ...valid(), actor })).not.toThrow();
  });
});
