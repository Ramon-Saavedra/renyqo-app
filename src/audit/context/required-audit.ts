import type { Prisma } from '../../generated/prisma/client';
import { auditEffectKey } from '../commands/audit-command';
import type { AuditSignals } from '../observability/audit-signals';
import { auditFailure } from '../observability/audit-failure';
import {
  validDomainEffect,
  type DomainAuditEffect,
} from '../domain/domain-evidence';

export type AuditEffect = Readonly<{
  effectKey: string;
  changes: Readonly<Record<string, never>>;
  metadata: Readonly<{ activationVersion: 1 }>;
}>;
export interface RequiredAudit {
  append(effect: AuditEffect | DomainAuditEffect): Promise<string>;
}

function valid(effect: AuditEffect) {
  return (
    effect &&
    Object.keys(effect).every((k) =>
      ['effectKey', 'changes', 'metadata'].includes(k),
    ) &&
    typeof effect.effectKey === 'string' &&
    auditEffectKey.test(effect.effectKey) &&
    effect.changes &&
    Object.getPrototypeOf(effect.changes) === Object.prototype &&
    Object.keys(effect.changes).length === 0 &&
    effect.metadata &&
    Object.getPrototypeOf(effect.metadata) === Object.prototype &&
    Object.keys(effect.metadata).length === 1 &&
    effect.metadata.activationVersion === 1
  );
}

// A per-execution closure, not a global/ambient context or another transaction.
export async function withRequiredAudit<T>(
  tx: Prisma.TransactionClient,
  id: string,
  signals: AuditSignals,
  work: (audit: RequiredAudit) => Promise<T>,
): Promise<T> {
  let active = true;
  const audit: RequiredAudit = Object.freeze({
    async append(effect: AuditEffect | DomainAuditEffect) {
      if (!active) {
        signals.report('AUDIT_CONTEXT_MISSING');
        await tx.$executeRaw`SELECT reject_required_audit()`;
        throw new Error('Audit execution has ended');
      }
      const domain =
        effect && typeof effect === 'object' && 'evidence' in effect;
      if (domain ? !validDomainEffect(effect) : !valid(effect)) {
        signals.report('AUDIT_PAYLOAD_REJECTED');
        // Poison the outer transaction even if the caller catches this failure.
        await tx.$executeRaw`SELECT reject_required_audit()`;
        throw new TypeError('Invalid audit effect');
      }
      try {
        if (domain) {
          const [row] = await tx.$queryRaw<
            { id: string }[]
          >`SELECT append_domain_audit_event(${id}::uuid,${effect.effectKey},${effect.evidence.kind},${effect.evidence.id}::uuid) AS id`;
          return row.id;
        }
        const foundation = effect;
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          SELECT append_context_audit_event(${id}::uuid,${foundation.effectKey},
            ${JSON.stringify(foundation.changes)}::jsonb,${JSON.stringify(foundation.metadata)}::jsonb) AS id`;
        return row.id;
      } catch (error) {
        signals.report('AUDIT_APPEND_FAILED');
        throw auditFailure('Required audit append failed', error);
      }
    },
  });
  try {
    const result = await work(audit);
    try {
      await tx.$executeRaw`SELECT close_audit_execution(${id}::uuid)`;
    } catch (error) {
      signals.report('AUDIT_APPEND_FAILED');
      throw auditFailure('Required audit completion failed', error);
    }
    return result;
  } finally {
    active = false;
  }
}
