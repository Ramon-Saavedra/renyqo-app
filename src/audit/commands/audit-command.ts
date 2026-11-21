import { randomUUID } from 'node:crypto';

export type AuditCommand = Readonly<{
  commandId: string;
  commandScope: 'audit.ledger.activation';
  correlationId: string;
  causationId?: string;
  requiredEffects: readonly string[];
}>;
export const auditId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const auditEffectKey = /^[a-z][a-z0-9_.:-]{0,79}$/;
function validEffects(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const effects: readonly unknown[] = value;
  return (
    effects.length > 0 &&
    effects.length <= 32 &&
    new Set(effects).size === effects.length &&
    effects.every((key) => typeof key === 'string' && auditEffectKey.test(key))
  );
}

// Called by a server adapter before entering Serializable retries. Existing
// domain receipts still own replay and input-fingerprint semantics.
export function auditCommand(input: AuditCommand): AuditCommand {
  if (
    !input ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some(
      (key) =>
        ![
          'commandId',
          'commandScope',
          'correlationId',
          'causationId',
          'requiredEffects',
        ].includes(key),
    ) ||
    typeof input.commandId !== 'string' ||
    typeof input.correlationId !== 'string' ||
    !auditId.test(input.commandId) ||
    !auditId.test(input.correlationId) ||
    (input.causationId !== undefined &&
      (typeof input.causationId !== 'string' ||
        !auditId.test(input.causationId))) ||
    input.commandScope !== 'audit.ledger.activation' ||
    !validEffects(input.requiredEffects)
  )
    throw new TypeError('Invalid audit command');
  return Object.freeze({
    ...input,
    requiredEffects: Object.freeze([...input.requiredEffects]),
  });
}

export function newAuditCorrelationId() {
  return randomUUID();
}
