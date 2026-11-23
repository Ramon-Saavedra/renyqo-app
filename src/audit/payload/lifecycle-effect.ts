import { auditId, auditEffectKey } from '../commands/audit-command';
import {
  LISTING_AUDIT_FIELDS,
  type LifecycleAuditEffect,
} from '../domain/lifecycle-action';
function exact(
  v: unknown,
  keys: readonly string[],
): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    Object.getPrototypeOf(v) === Object.prototype &&
    Object.keys(v).length === keys.length &&
    Object.keys(v).every((k) => keys.includes(k))
  );
}
export function validLifecycleEffect(v: unknown): v is LifecycleAuditEffect {
  if (
    !exact(v, ['effectKey', 'transition']) ||
    typeof v.effectKey !== 'string' ||
    !auditEffectKey.test(v.effectKey)
  )
    return false;
  const t = v.transition;
  if (exact(t, ['kind', 'activityId']) && t.kind === 'APPLICATION_ACTIVITY')
    return typeof t.activityId === 'string' && auditId.test(t.activityId);
  return (
    exact(t, [
      'kind',
      'listingId',
      'previousStatus',
      'revisionBefore',
      'changedFieldNames',
      'ordering',
      'previousPosition',
    ]) &&
    t.kind === 'LISTING_STATE' &&
    typeof t.listingId === 'string' &&
    auditId.test(t.listingId) &&
    (t.previousStatus === null ||
      ['DRAFT', 'PUBLISHED', 'PAUSED', 'RENTED', 'RETIRED'].includes(
        t.previousStatus as string,
      )) &&
    (t.revisionBefore === null ||
      (Number.isInteger(t.revisionBefore) && Number(t.revisionBefore) > 0)) &&
    typeof t.ordering === 'boolean' &&
    (t.previousPosition === null || Number.isInteger(t.previousPosition)) &&
    Array.isArray(t.changedFieldNames) &&
    t.changedFieldNames.length <= LISTING_AUDIT_FIELDS.length &&
    t.changedFieldNames.every(
      (k) =>
        typeof k === 'string' &&
        (LISTING_AUDIT_FIELDS as readonly string[]).includes(k),
    ) &&
    new Set(t.changedFieldNames).size === t.changedFieldNames.length
  );
}
