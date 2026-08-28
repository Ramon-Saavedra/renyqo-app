import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { runSerializableTransaction } from './run-serializable-transaction';

type TransactionOperation<T> = (tx: Prisma.TransactionClient) => Promise<T>;
type TransactionFn = <T>(
  operation: TransactionOperation<T>,
  options?: { isolationLevel?: string },
) => Promise<T>;
type MockPrisma = { $transaction: jest.MockedFunction<TransactionFn> };
type PrismaWithTransaction = Pick<PrismaClient, '$transaction'>;

function createMockPrisma(): MockPrisma {
  return {
    $transaction: jest.fn(<T>(operation: TransactionOperation<T>) =>
      operation({} as Prisma.TransactionClient),
    ) as jest.MockedFunction<TransactionFn>,
  };
}

function asPrismaWithTransaction(
  mockPrisma: MockPrisma,
): PrismaWithTransaction {
  return mockPrisma as unknown as PrismaWithTransaction;
}

describe('runSerializableTransaction', () => {
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it('returns the operation result on the first attempt', async () => {
    const operation = jest.fn().mockResolvedValue('result');

    const result = await runSerializableTransaction(
      asPrismaWithTransaction(prisma),
      operation,
    );

    expect(result).toBe('result');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(operation, {
      isolationLevel: 'Serializable',
    });
  });

  it('retries on a top-level P2034 error', async () => {
    const conflictError = new PrismaClientKnownRequestError(
      'serialization conflict',
      { code: 'P2034', clientVersion: 'test' },
    );
    const operation = jest
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce('success');

    const result = await runSerializableTransaction(
      asPrismaWithTransaction(prisma),
      operation,
    );

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on a driver-adapter serialization conflict', async () => {
    const conflictError = {
      code: 'P2034',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '40001' },
        },
      },
    };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce('success');

    const result = await runSerializableTransaction(
      asPrismaWithTransaction(prisma),
      operation,
    );

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('retries on a nested cause with originalCode 40001', async () => {
    const conflictError = {
      code: 'P2034',
      cause: {
        originalCode: '40001',
      },
    };
    const operation = jest
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce('success');

    const result = await runSerializableTransaction(
      asPrismaWithTransaction(prisma),
      operation,
    );

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws non-serialization errors immediately', async () => {
    const otherError = new Error('something else');
    const operation = jest.fn().mockRejectedValue(otherError);

    await expect(
      runSerializableTransaction(asPrismaWithTransaction(prisma), operation),
    ).rejects.toThrow('something else');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('throws a custom fallback message after exhausting retries', async () => {
    const conflictError = new PrismaClientKnownRequestError(
      'serialization conflict',
      { code: 'P2034', clientVersion: 'test' },
    );
    const operation = jest.fn().mockRejectedValue(conflictError);

    await expect(
      runSerializableTransaction(asPrismaWithTransaction(prisma), operation, {
        maxRetries: 2,
        fallbackMessage: 'Custom fallback',
      }),
    ).rejects.toThrow('Custom fallback');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('uses the default fallback message when none is provided', async () => {
    const conflictError = new PrismaClientKnownRequestError(
      'serialization conflict',
      { code: 'P2034', clientVersion: 'test' },
    );
    const operation = jest.fn().mockRejectedValue(conflictError);

    await expect(
      runSerializableTransaction(asPrismaWithTransaction(prisma), operation, {
        maxRetries: 2,
      }),
    ).rejects.toThrow('Transaction could not be completed');
  });
});
