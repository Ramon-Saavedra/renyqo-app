import { AuthRevocationService } from './auth-revocation.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { RealtimeConnectionsService } from '../../realtime/realtime-connections.service';

describe('AuthRevocationService', () => {
  const update = jest.fn();
  const query = jest.fn();
  const cleanup = jest.fn<
    Promise<number>,
    [TemplateStringsArray, ...unknown[]]
  >();
  const disconnect = jest.fn();
  let service: AuthRevocationService;
  beforeEach(() => {
    update.mockReset().mockResolvedValue({ authVersion: 2 });
    query.mockReset().mockResolvedValue([{ sid: 'old' }]);
    cleanup.mockReset().mockResolvedValue(1);
    disconnect.mockReset();
    service = new AuthRevocationService(
      { $executeRaw: cleanup } as unknown as PrismaService,
      {
        disconnectSessions: disconnect,
      } as unknown as RealtimeConnectionsService,
    );
  });
  it('increments atomically using the caller transaction and captures old session IDs', async () => {
    const tx = {
      user: { update },
      $queryRaw: query,
    } as unknown as Prisma.TransactionClient;
    expect(await service.revokeAll(tx, 'user')).toEqual({
      authVersion: 2,
      sessionIds: ['old'],
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'user' },
      data: { authVersion: { increment: 1 } },
      select: { authVersion: true },
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
  it('targets only captured IDs and does not delete current-version sessions', async () => {
    await service.cleanup({ authVersion: 2, sessionIds: ['old'] });
    expect(cleanup.mock.calls[0]).toContainEqual(['old']);
    expect(String(cleanup.mock.calls[0][0])).toContain('IS DISTINCT FROM');
    expect(disconnect).toHaveBeenCalledWith(['old']);
  });
  it('continues socket cleanup when session deletion fails', async () => {
    cleanup.mockRejectedValue(new Error('store unavailable'));
    await expect(
      service.cleanup({ authVersion: 2, sessionIds: ['old'] }),
    ).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledWith(['old']);
  });
  it('does not propagate realtime cleanup failures', async () => {
    disconnect.mockImplementation(() => {
      throw new Error('disconnect unavailable');
    });
    await expect(
      service.cleanup({ authVersion: 2, sessionIds: ['old'] }),
    ).resolves.toBeUndefined();
  });
  it('handles duplicate and empty cleanup safely', async () => {
    await service.cleanup({ authVersion: 2, sessionIds: [] });
    expect(cleanup).not.toHaveBeenCalled();
    await service.cleanup({ authVersion: 2, sessionIds: ['old'] });
    await service.cleanup({ authVersion: 2, sessionIds: ['old'] });
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
