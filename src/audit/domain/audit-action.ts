// Slice 1 reserves only the foundation contract. No business adoption is active.
export const AUDIT_ACTION = 'audit.ledger.activated' as const;
export const AUDIT_SCHEMA_VERSION = 1 as const;
export type AuditAction = typeof AUDIT_ACTION;
