import { randomUUID } from 'node:crypto';
import { validDomainEffect, type DomainAuditEffect } from './domain-evidence';
import { auditCommand } from '../commands/audit-command';
describe('Closed domain evidence reference contract', () => {
  const effect = () => ({
    effectKey: `invitation.created:${randomUUID()}`,
    evidence: { kind: 'INVITATION_COMMAND' as const, id: randomUUID() },
  });
  it('accepts evidence references and the explicit adopted command scopes', () => {
    expect(validDomainEffect(effect())).toBe(true);
    expect(
      auditCommand({
        commandId: randomUUID(),
        commandScope: 'provider.invitation',
        correlationId: randomUUID(),
        requiredEffects: [effect().effectKey],
      }).commandScope,
    ).toBe('provider.invitation');
  });
  it.each(['token', 'tokenHash', 'email', 'sessionId', 'changes', 'metadata'])(
    'rejects extra %s rather than silently discarding it',
    (key) => {
      expect(
        validDomainEffect({
          ...effect(),
          [key]: 'forbidden',
        }),
      ).toBe(false);
      const ref = effect();
      expect(
        validDomainEffect({
          ...ref,
          evidence: { ...ref.evidence, [key]: 'forbidden' },
        }),
      ).toBe(false);
    },
  );
  it('rejects unknown evidence kinds and arbitrary IDs', () => {
    expect(
      validDomainEffect({
        ...effect(),
        evidence: { kind: 'ENTITY_DUMP', id: randomUUID() },
      } as unknown as DomainAuditEffect),
    ).toBe(false);
    expect(
      validDomainEffect({
        ...effect(),
        evidence: { kind: 'ASSIGNMENT', id: 'secret-value' },
      }),
    ).toBe(false);
  });
});
