import { PasswordResetTokensRepository } from './password-reset-tokens.repository';
import { PrismaService } from '../prisma/prisma.service';
import { AuthRevocationService } from './session/auth-revocation.service';

describe('PasswordResetTokensRepository commit ordering', () => {
  const input = {
    tokenHash: 'hash',
    passwordHash: 'new-hash',
    now: new Date(),
  };
  const revoked = { authVersion: 2, sessionIds: ['old'] };
  let tx: {
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock<
      Promise<number>,
      [TemplateStringsArray, ...unknown[]]
    >;
  };
  let revocations: { revokeAll: jest.Mock; cleanup: jest.Mock };
  let transaction: jest.Mock;
  let repository: PasswordResetTokensRepository;
  let committed: boolean;
  beforeEach(() => {
    committed = false;
    tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'token', user_id: 'user' }]),
      $executeRaw: jest
        .fn<Promise<number>, [TemplateStringsArray, ...unknown[]]>()
        .mockResolvedValue(1),
    };
    revocations = {
      revokeAll: jest.fn().mockResolvedValue(revoked),
      cleanup: jest.fn().mockImplementation(() => {
        expect(committed).toBe(true);
      }),
    };
    transaction = jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        const result = await callback(tx);
        committed = true;
        return result;
      },
    );
    repository = new PasswordResetTokensRepository(
      { $transaction: transaction } as unknown as PrismaService,
      revocations as unknown as AuthRevocationService,
    );
  });
  it('updates password/token and revokes inside the transaction, then cleans up after commit', async () => {
    expect(await repository.consumeValidTokenAndUpdatePassword(input)).toBe(
      true,
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(String(tx.$executeRaw.mock.calls[0][0])).toContain('UPDATE "users"');
    expect(String(tx.$executeRaw.mock.calls[1][0])).toContain(
      'UPDATE "password_reset_tokens"',
    );
    expect(revocations.revokeAll).toHaveBeenCalledWith(tx, 'user');
    expect(revocations.cleanup).toHaveBeenCalledWith(revoked);
  });
  it('does nothing for an invalid or consumed token', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    expect(await repository.consumeValidTokenAndUpdatePassword(input)).toBe(
      false,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(revocations.revokeAll).not.toHaveBeenCalled();
    expect(revocations.cleanup).not.toHaveBeenCalled();
  });
  it('does not clean up after a transaction/commit failure', async () => {
    transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => {
        await callback(tx);
        throw new Error('commit failed');
      },
    );
    await expect(
      repository.consumeValidTokenAndUpdatePassword(input),
    ).rejects.toThrow('commit failed');
    expect(revocations.cleanup).not.toHaveBeenCalled();
  });
});
