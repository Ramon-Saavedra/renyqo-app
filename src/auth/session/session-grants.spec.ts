import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import type { SafeUser } from '../../users/types/safe-user.type';
import { SessionInfrastructureService } from './session-infrastructure.service';

describe('Durable session grant writes', () => {
  const execute = jest.fn<
    Promise<number>,
    [TemplateStringsArray, ...unknown[]]
  >();
  const deleteMany = jest.fn();
  let service: SessionInfrastructureService;
  const user = { id: 'validated-user', authVersion: 3 } as SafeUser;
  beforeEach(() => {
    execute.mockReset().mockResolvedValue(1);
    deleteMany.mockReset().mockResolvedValue({ count: 1 });
    service = new SessionInfrastructureService(
      new ConfigService({ SESSION_SECRET: 'test' }),
      {
        $executeRaw: execute,
        sessionAuthGrant: { deleteMany },
      } as unknown as PrismaService,
    );
  });
  it('creates only a final persisted SID bound to current user and credential version', async () => {
    await service.establishGrant('final-sid', user);
    expect(execute.mock.calls[0].slice(1)).toEqual([
      'final-sid',
      'validated-user',
      3,
    ]);
    expect(String(execute.mock.calls[0][0])).toContain(
      's.expire > CURRENT_TIMESTAMP',
    );
    expect(String(execute.mock.calls[0][0])).toContain('u.auth_version =');
    expect(String(execute.mock.calls[0][0])).toContain(
      'INSERT INTO session_auth_grants',
    );
  });
  it('rejects establishment when durable user/session state no longer matches', async () => {
    execute.mockResolvedValue(0);
    await expect(service.establishGrant('final-sid', user)).rejects.toThrow(
      'Session establishment failed',
    );
  });
  it('does not hide database write failure', async () => {
    execute.mockRejectedValue(new Error('database unavailable'));
    await expect(service.establishGrant('sid', user)).rejects.toThrow(
      'database unavailable',
    );
  });
  it.each([undefined, 0, -1, 1.5, '3'])(
    'refuses invalid server version %j',
    async (authVersion) => {
      await expect(
        service.establishGrant('sid', { id: 'user', authVersion } as SafeUser),
      ).rejects.toThrow('Session establishment failed');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('revokes only the requested SID and treats repeated deletion as success', async () => {
    await service.revokeGrant('one-sid');
    deleteMany.mockResolvedValue({ count: 0 });
    await service.revokeGrant('one-sid');
    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: { sid: 'one-sid' },
    });
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });
});
