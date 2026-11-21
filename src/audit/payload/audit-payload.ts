import { AUDIT_ACTION, AUDIT_SCHEMA_VERSION } from '../domain/audit-action';
import type { AuditEventInput } from '../domain/audit-event';

export const AUDIT_PAYLOAD_MAX_BYTES = 8192;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = [
  'id',
  'workspaceId',
  'action',
  'schemaVersion',
  'actor',
  'resourceType',
  'resourceId',
  'listingId',
  'resourceRevisionBefore',
  'resourceRevisionAfter',
  'revisionKind',
  'occurredAt',
  'source',
  'correlationId',
  'causationId',
  'commandId',
  'commandScope',
  'effectKey',
  'sourceEvidenceType',
  'sourceEvidenceId',
  'changes',
  'metadata',
];
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function exact(value: unknown, allowed: readonly string[]) {
  return (
    record(value) && Object.keys(value).every((key) => allowed.includes(key))
  );
}
function fail(): never {
  throw new TypeError('Invalid audit event contract');
}

// Exact action-specific keys are the safety boundary; a secret-name blacklist
// alone could never prevent entity dumps or innocently named sensitive values.
export function validateAuditEvent(value: unknown): AuditEventInput {
  if (!exact(value, keys) || !record(value)) fail();
  if (
    value.action !== AUDIT_ACTION ||
    value.schemaVersion !== AUDIT_SCHEMA_VERSION ||
    value.resourceType !== 'WORKSPACE' ||
    value.source !== 'INTERNAL' ||
    value.commandScope !== 'audit.ledger.activation' ||
    value.effectKey !== 'activation'
  )
    fail();
  for (const key of [
    'id',
    'workspaceId',
    'resourceId',
    'correlationId',
    'commandId',
  ])
    if (typeof value[key] !== 'string' || !uuid.test(value[key])) fail();
  if (value.resourceId !== value.workspaceId) fail();
  // Routing/revision/evidence slots are reserved, not arbitrary extension bags.
  for (const key of [
    'listingId',
    'resourceRevisionBefore',
    'resourceRevisionAfter',
    'revisionKind',
    'sourceEvidenceType',
    'sourceEvidenceId',
  ])
    if (value[key] !== undefined) fail();
  if (
    value.causationId !== undefined &&
    (typeof value.causationId !== 'string' || !uuid.test(value.causationId))
  )
    fail();
  if (
    typeof value.occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurredAt) ||
    !Number.isFinite(Date.parse(value.occurredAt))
  )
    fail();
  const actor = value.actor;
  if (!record(actor)) fail();
  if (actor.kind === 'SYSTEM') {
    if (
      !exact(actor, ['kind', 'purpose']) ||
      actor.purpose !== 'AUDIT_LEDGER_ACTIVATION'
    )
      fail();
  } else {
    if (actor.kind !== 'USER' && actor.kind !== 'MEMBER') fail();
    if (
      !exact(
        actor,
        actor.kind === 'USER'
          ? ['kind', 'userId']
          : ['kind', 'userId', 'membershipId'],
      )
    )
      fail();
    if (typeof actor.userId !== 'string' || !uuid.test(actor.userId)) fail();
    if (
      actor.kind === 'MEMBER' &&
      (typeof actor.membershipId !== 'string' || !uuid.test(actor.membershipId))
    )
      fail();
  }
  if (
    !exact(value.changes, []) ||
    !exact(value.metadata, ['activationVersion']) ||
    !record(value.metadata) ||
    value.metadata.activationVersion !== 1
  )
    fail();
  if (
    Buffer.byteLength(JSON.stringify(value.changes)) +
      Buffer.byteLength(JSON.stringify(value.metadata)) >
    AUDIT_PAYLOAD_MAX_BYTES
  )
    fail();
  return value as unknown as AuditEventInput;
}
