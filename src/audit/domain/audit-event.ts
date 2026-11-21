import type { AuditAction } from './audit-action';

export type AuditActor =
  | Readonly<{ kind: 'USER'; userId: string }>
  | Readonly<{ kind: 'MEMBER'; userId: string; membershipId: string }>
  | Readonly<{ kind: 'SYSTEM'; purpose: 'AUDIT_LEDGER_ACTIVATION' }>;

// INTEGRATION is reserved in storage, but no integration append contract exists.
export type AuditEventInput = Readonly<{
  id: string;
  workspaceId: string;
  action: AuditAction;
  schemaVersion: 1;
  actor: AuditActor;
  resourceType: 'WORKSPACE';
  resourceId: string;
  listingId?: string;
  resourceRevisionBefore?: number;
  resourceRevisionAfter?: number;
  revisionKind?: string;
  occurredAt: string;
  source: 'INTERNAL';
  correlationId: string;
  causationId?: string;
  commandId: string;
  commandScope: 'audit.ledger.activation';
  effectKey: 'activation';
  sourceEvidenceType?: string;
  sourceEvidenceId?: string;
  changes: Readonly<Record<string, never>>;
  metadata: Readonly<{ activationVersion: 1 }>;
}>;
