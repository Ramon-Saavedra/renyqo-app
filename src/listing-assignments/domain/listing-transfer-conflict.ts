import { ConflictException } from '@nestjs/common';

const staleTransferMessage = 'Transfer request is stale or ineligible';

function isStaleTransferFailure(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  const record = value as Record<string, unknown>;
  return (
    ((record.code === '23514' || record.originalCode === '23514') &&
      (record.message === staleTransferMessage ||
        record.originalMessage === staleTransferMessage)) ||
    ['meta', 'cause', 'driverAdapterError'].some((key) =>
      isStaleTransferFailure(record[key], depth + 1),
    )
  );
}

export function translateListingTransferFailure(error: unknown): never {
  if (isStaleTransferFailure(error))
    throw new ConflictException(staleTransferMessage);
  throw error;
}
