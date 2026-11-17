import { capacityConflict } from '../capacity/capacity.policy';
const codes = [
  'PLAN_UNAVAILABLE',
  'LISTING_LIMIT_REACHED',
  'SEAT_LIMIT_REACHED',
  'DOWNGRADE_BLOCKED',
] as const;
export function translateCapacityFailure(error: unknown): never {
  function find(value: unknown, depth = 0): string | undefined {
    if (!value || typeof value !== 'object' || depth > 7) return;
    const r = value as Record<string, unknown>;
    if (r.code === '23514' || r.originalCode === '23514') {
      const code = codes.find(
        (c) => r.constraint === c || r.message === c || r.originalMessage === c,
      );
      if (code) return code;
      if (
        r.message === 'Ownership revision changed' ||
        r.originalMessage === 'Ownership revision changed'
      )
        return 'OWNERSHIP_REVISION_CONFLICT';
    }
    for (const key of ['meta', 'cause', 'driverAdapterError']) {
      const code = find(r[key], depth + 1);
      if (code) return code;
    }
  }
  const code = find(error);
  if (code) capacityConflict(code);
  throw error;
}
