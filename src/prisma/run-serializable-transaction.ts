import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { Prisma, PrismaClient } from '../generated/prisma/client';

const DEFAULT_RETRIES = 8;

type TransactionClient = Prisma.TransactionClient;
type TransactionOperation<T> = (tx: TransactionClient) => Promise<T>;
type PrismaWithTransaction = Pick<PrismaClient, '$transaction'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasSerializationCode(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (value.code === 'P2034') {
    return true;
  }

  if (isRecord(value.cause) && hasSerializationCode(value.cause)) {
    return true;
  }

  return false;
}

function isPrismaRawQuerySerializationConflict(value: unknown): boolean {
  if (!isRecord(value) || value.code !== 'P2010' || !isRecord(value.meta)) {
    return false;
  }

  const driverAdapterError = value.meta.driverAdapterError;
  if (!isRecord(driverAdapterError) || !isRecord(driverAdapterError.cause)) {
    return false;
  }

  return driverAdapterError.cause.originalCode === '40001';
}

function isSerializationConflict(error: unknown): boolean {
  if (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    return true;
  }

  return (
    hasSerializationCode(error) || isPrismaRawQuerySerializationConflict(error)
  );
}

export async function runSerializableTransaction<T>(
  prisma: PrismaWithTransaction,
  operation: TransactionOperation<T>,
  options: { maxRetries?: number; fallbackMessage?: string } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: 'Serializable',
      });
    } catch (err) {
      if (!isSerializationConflict(err)) {
        throw err;
      }

      if (attempt === maxRetries - 1) {
        break;
      }

      const delayMs = Math.min(250, 10 * 2 ** attempt);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    options.fallbackMessage ?? 'Transaction could not be completed',
  );
}
