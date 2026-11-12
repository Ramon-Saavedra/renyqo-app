import type { Prisma } from '../../generated/prisma/client';
import { AuthorityLockRepository } from './authority-lock.repository';

describe('Global participant eligibility lock order', () => {
  it('locks all declared Users in database UUID order before the session grant', async () => {
    const userId = '00000000-0000-4000-8000-000000000002';
    const target = '00000000-0000-4000-8000-000000000001';
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: userId }, { id: target }])
      .mockResolvedValueOnce([]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await new AuthorityLockRepository().global(
      tx,
      {
        mode: 'SESSION_BOUND',
        userId,
        authVersion: 1,
        sessionId: 'sid',
      },
      [target, target, userId],
    );
    const calls = query.mock.calls as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    expect(calls[0][0].join('?')).toContain('ORDER BY id FOR SHARE');
    expect(calls[0][1]).toEqual([userId, target]);
    expect(calls[1][0].join('?')).toContain('session_auth_grants');
  });

  it('rejects a missing participant before acquiring the session grant', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    await expect(
      new AuthorityLockRepository().global(tx, {
        mode: 'SESSION_BOUND',
        userId: '00000000-0000-4000-8000-000000000001',
        authVersion: 1,
        sessionId: 'sid',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
