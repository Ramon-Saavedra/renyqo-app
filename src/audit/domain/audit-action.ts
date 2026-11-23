// The private foundation writer stays closed. Domain actions are appended only
// through the typed evidence-reference path, never its foundation envelope.
export const AUDIT_ACTION = 'audit.ledger.activated' as const;
export const AUDIT_SCHEMA_VERSION = 1 as const;
export type AuditAction = typeof AUDIT_ACTION;
export type RecordedAuditAction =
  | AuditAction
  | import('./domain-action').DomainAuditAction
  | keyof import('./lifecycle-action').LifecyclePayloads;
