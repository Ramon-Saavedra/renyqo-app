// Preserve the existing Serializable retry contract without retaining/logging a
// Prisma/pg error that can contain SQL parameters or sensitive actor/session data.
export function auditFailure(message: string, cause: unknown): Error {
  const seen = new Set<object>();
  function serialized(value: unknown, depth = 0): boolean {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value))
      return false;
    seen.add(value);
    const row = value as Record<string, unknown>;
    return (
      row.code === 'P2034' ||
      row.code === '40001' ||
      row.originalCode === '40001' ||
      ['cause', 'meta', 'driverAdapterError'].some((key) =>
        serialized(row[key], depth + 1),
      )
    );
  }
  const error: Error & { code?: string } = new Error(message);
  if (serialized(cause)) error.code = 'P2034';
  return error;
}
