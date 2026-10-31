import { RealtimeConnectionsService } from './realtime-connections.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeSessionService } from './realtime-session.service';
import type { RealtimeSocket } from './realtime-socket';
import { Role } from '../generated/prisma/enums';

describe('Realtime revocation when socket cleanup throws', () => {
  function socket(id: string) {
    return {
      id,
      conn: { readyState: 'open' },
      data: {},
      connected: true,
      once: jest.fn(),
      onAny: jest.fn(),
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
    };
  }
  const identity = { sessionId: 'old', userId: 'user', role: Role.APPLICANT };
  let service: RealtimeConnectionsService;
  beforeEach(() => {
    service = new RealtimeConnectionsService(
      {
        connectionLimit: 10,
        sessionLimit: 10,
        recheckMs: 100000,
      } as RealtimeConfigService,
      {
        valid: jest.fn().mockResolvedValue(new Map()),
      } as unknown as RealtimeSessionService,
    );
  });
  it('attempts every captured connection despite one failed disconnect', async () => {
    const first = socket('first'),
      second = socket('second');
    await service.add(first as unknown as RealtimeSocket, identity);
    await service.add(second as unknown as RealtimeSocket, identity);
    first.disconnect.mockImplementation(() => {
      throw new Error('socket failed');
    });
    try {
      expect(() => service.disconnectSessions(['old'])).not.toThrow();
      expect(second.disconnect).toHaveBeenCalledWith(true);
      expect(() => service.disconnectSessions(['already-gone'])).not.toThrow();
    } finally {
      first.disconnect.mockReset();
      await service.onModuleDestroy();
    }
  });
  it('excludes invalid sessions from publication even when the socket stays connected', async () => {
    const stale = socket('stale');
    await service.add(stale as unknown as RealtimeSocket, identity);
    stale.disconnect.mockImplementation(() => {
      throw new Error('socket failed');
    });
    try {
      await expect(service.eligible(['user'])).resolves.toEqual([]);
      expect(stale.disconnect).toHaveBeenCalledWith(true);
    } finally {
      stale.disconnect.mockReset();
      await service.onModuleDestroy();
    }
  });
});
