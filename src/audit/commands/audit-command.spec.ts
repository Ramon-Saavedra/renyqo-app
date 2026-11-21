import { randomUUID } from 'node:crypto';
import { auditCommand, type AuditCommand } from './audit-command';
import { auditPage } from '../queries/audit-page';
const input = (): AuditCommand => ({
  commandId: randomUUID(),
  commandScope: 'audit.ledger.activation',
  correlationId: randomUUID(),
  causationId: randomUUID(),
  requiredEffects: ['first', 'second'],
});
describe('Audit command/effect and bounded cursor contracts', () => {
  it('captures immutable command/causation and multiple required effects', () => {
    const original = input(),
      bound = auditCommand(original);
    expect(bound).toEqual(original);
    expect(bound.requiredEffects).not.toBe(original.requiredEffects);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.requiredEffects)).toBe(true);
  });
  it.each([
    { commandId: 'bad' },
    { commandScope: 'anything' },
    { requiredEffects: [] },
    { requiredEffects: ['same', 'same'] },
    { requiredEffects: ['secret body'] },
    { correlationId: 'bad' },
    { causationId: 'bad' },
    { requiredEffects: Array.from({ length: 33 }, (_, i) => `effect.${i}`) },
  ])('rejects invalid command binding', (patch) =>
    expect(() =>
      auditCommand({ ...input(), ...patch } as AuditCommand),
    ).toThrow(TypeError),
  );
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: 1, before: { id: randomUUID(), recordedAt: 'infinity' } },
  ])('rejects unbounded/invalid pages', (page) =>
    expect(() => auditPage(page)).toThrow(TypeError),
  );
});
