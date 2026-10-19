import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeConnectionsService } from '../realtime/realtime-connections.service';
import { PasswordResetTokensRepository } from './password-reset-tokens.repository';

type PasswordResetTokenRow = {
  id: string;
  user_id: string;
};

type QueryRawMock = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<PasswordResetTokenRow[]>;

type ExecuteRaw = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<number>;

type MockTransactionClient = {
  $queryRaw: jest.MockedFunction<QueryRawMock>;
  $executeRaw: jest.MockedFunction<ExecuteRaw>;
};

describe('PasswordResetTokensRepository', () => {
  let repository: PasswordResetTokensRepository;
  let realtimeConnections: { disconnectUser: jest.Mock };
  let tx: MockTransactionClient;
  let transaction: jest.MockedFunction<
    (
      callback: (client: MockTransactionClient) => Promise<boolean>,
    ) => Promise<boolean>
  >;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn<QueryRawMock>(),
      $executeRaw: jest.fn<ExecuteRaw>(),
    };
    tx.$executeRaw.mockResolvedValue(1);
    transaction = jest.fn((callback) => callback(tx));
    realtimeConnections = { disconnectUser: jest.fn() };
    repository = new PasswordResetTokensRepository(
      {
        $transaction: transaction,
        $executeRaw: jest.fn<ExecuteRaw>(),
      } as unknown as PrismaService,
      realtimeConnections as unknown as RealtimeConnectionsService,
    );
  });

  it('updates password, marks token used and invalidates sessions for a valid token', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: '00000000-0000-4000-8000-000000000002',
        user_id: '00000000-0000-4000-8000-000000000001',
      },
    ]);

    const result = await repository.consumeValidTokenAndUpdatePassword({
      tokenHash: 'a'.repeat(64),
      passwordHash: 'new_password_hash',
      now: new Date('2026-07-19T12:00:00.000Z'),
    });

    expect(result).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(String(tx.$executeRaw.mock.calls[0]?.[0])).toContain(
      'UPDATE "users"',
    );
    expect(String(tx.$executeRaw.mock.calls[1]?.[0])).toContain(
      'UPDATE "password_reset_tokens"',
    );
    expect(String(tx.$executeRaw.mock.calls[2]?.[0])).toContain(
      'DELETE FROM "user_sessions"',
    );
    expect(realtimeConnections.disconnectUser).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('does not update password or sessions when token is invalid', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    const result = await repository.consumeValidTokenAndUpdatePassword({
      tokenHash: 'b'.repeat(64),
      passwordHash: 'new_password_hash',
      now: new Date('2026-07-19T12:00:00.000Z'),
    });

    expect(result).toBe(false);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
