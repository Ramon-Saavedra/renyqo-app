import { auditFailure } from './audit-failure';
import { runSerializableTransaction } from '../../prisma/run-serializable-transaction';
import type { PrismaClient } from '../../generated/prisma/client';
describe('Sanitized audit infrastructure errors', () => {
  it('preserves serialization retry signals without retaining SQL/session payloads', async () => {
    const raw = {
      message: 'private session/SQL parameters',
      meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
    };
    const error = auditFailure('Audit operation failed', raw);
    expect(error).toMatchObject({
      message: 'Audit operation failed',
      code: 'P2034',
    });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('committed');
    const db = { $transaction: transaction } as unknown as Pick<
      PrismaClient,
      '$transaction'
    >;
    expect(
      await runSerializableTransaction(db, () => Promise.resolve('result')),
    ).toBe('committed');
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('does not turn integrity or authorization failures into retryable conflicts', () => {
    expect(
      auditFailure('Audit rejected', { code: '23514' }),
    ).not.toHaveProperty('code');
  });
});
