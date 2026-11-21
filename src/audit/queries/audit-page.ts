import { auditId } from '../commands/audit-command';
export type AuditCursor = Readonly<{ recordedAt: string; id: string }>;
export type AuditPageInput = Readonly<{ limit: number; before?: AuditCursor }>;
export function auditPage(input: AuditPageInput) {
  if (
    !input ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.before &&
      (!auditId.test(input.before.id) ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(input.before.recordedAt) ||
        !Number.isFinite(Date.parse(input.before.recordedAt))))
  )
    throw new TypeError('Invalid audit page');
  return Object.freeze({
    limit: input.limit,
    ...(input.before ? { before: Object.freeze({ ...input.before }) } : {}),
  });
}
export type AuditProjection = Readonly<{
  id: string;
  action: string;
  recordedAt: string;
  occurredAt: string;
  source: string;
  resourceType: string;
  resourceId: string;
  actor: Readonly<{
    kind: string;
    name?: string;
    role?: string;
    color?: string;
  }>;
  commandId: string;
  effectKey: string;
  correlationId: string;
  causationId: string | null;
}>;
