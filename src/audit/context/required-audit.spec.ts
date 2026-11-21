import type { Prisma } from '../../generated/prisma/client';
import { withRequiredAudit, type RequiredAudit } from './required-audit';
import { AuditSignals } from '../observability/audit-signals';
import { auditedWork } from './audited-work';
describe('Required audit failures and execution lifetime', () => {
  const signals = new AuditSignals();
  beforeEach(() =>
    jest.spyOn(signals, 'report').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());
  it.each([null, undefined, 42, 'invalid'])(
    'aborts required execution for malformed runtime input %s',
    async (value) => {
      const execute = jest
        .fn()
        .mockRejectedValue(new Error('transaction aborted'));
      const tx = {
        $executeRaw: execute,
        $queryRaw: jest.fn(),
      } as unknown as Prisma.TransactionClient;
      await expect(
        withRequiredAudit(tx, 'context', signals, (a) =>
          a.append(value as unknown as Parameters<RequiredAudit['append']>[0]),
        ),
      ).rejects.toThrow('transaction aborted');
      expect(execute).toHaveBeenCalled();
      expect(signals.report).toHaveBeenCalledWith('AUDIT_PAYLOAD_REJECTED');
    },
  );
  it('rejects sensitive payloads without sending them to persistence or logs', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(new Error('required audit rejected'));
    const query = jest.fn();
    const tx = {
      $executeRaw: execute,
      $queryRaw: query,
    } as unknown as Prisma.TransactionClient;
    await expect(
      withRequiredAudit(tx, 'context', signals, (a) =>
        a.append({
          effectKey: 'ok',
          changes: {},
          metadata: { password: 'secret' },
        } as unknown as Parameters<RequiredAudit['append']>[0]),
      ),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(signals.report).toHaveBeenCalledWith('AUDIT_PAYLOAD_REJECTED');
  });
  it('sanitizes database append errors and closes a successful execution', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'event' }])
      .mockRejectedValueOnce(new Error('raw SQL secret'));
    const tx = {
      $queryRaw: query,
      $executeRaw: jest.fn().mockResolvedValue(0),
    } as unknown as Prisma.TransactionClient;
    const effect = {
      effectKey: 'one',
      changes: {},
      metadata: { activationVersion: 1 as const },
    };
    expect(
      await withRequiredAudit(tx, 'context', signals, (a) => a.append(effect)),
    ).toBe('event');
    await expect(
      withRequiredAudit(tx, 'context', signals, (a) => a.append(effect)),
    ).rejects.toThrow('Required audit append failed');
    expect(signals.report).toHaveBeenCalledWith('AUDIT_APPEND_FAILED');
  });
  it('checks the outer transaction is usable after a swallowed callback failure', async () => {
    const tx = {
      $executeRaw: jest
        .fn()
        .mockRejectedValue(new Error('aborted transaction')),
    } as unknown as Prisma.TransactionClient;
    await expect(
      auditedWork(tx, () => Promise.resolve('misleading success')),
    ).rejects.toThrow('aborted transaction');
  });
});
