import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { SessionInfrastructureService } from '../auth/session/session-infrastructure.service';
import { Role } from '../generated/prisma/enums';
import {
  RealtimeSessionService,
  RealtimeUnauthenticatedError,
} from './realtime-session.service';

describe('Session lookup batching', () => {
  const query = jest.fn<() => Promise<unknown[]>>();
  const signedSessionId = jest.fn<() => string | null>(() => 'session');
  let service: RealtimeSessionService;
  beforeEach(async () => {
    query.mockReset().mockResolvedValue([]);
    signedSessionId.mockReset().mockReturnValue('session');
    const module = await Test.createTestingModule({
      providers: [
        RealtimeSessionService,
        { provide: PrismaService, useValue: { $queryRaw: query } },
        {
          provide: SessionInfrastructureService,
          useValue: { signedSessionId },
        },
      ],
    }).compile();
    service = module.get(RealtimeSessionService);
  });
  it('deduplicates sessions instead of querying once per socket', async () => {
    query.mockResolvedValue([
      { sessionId: 'session', userId: 'user', role: Role.APPLICANT },
    ]);
    expect(
      (await service.valid(Array<string>(1000).fill('session'))).size,
    ).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('uses bounded batches and skips empty requests', async () => {
    await service.valid([]);
    expect(query).not.toHaveBeenCalled();
    await service.valid(Array.from({ length: 401 }, (_, i) => `session-${i}`));
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('propagates database failure instead of treating it as no recipients', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(service.valid(['session'])).rejects.toThrow(
      'database unavailable',
    );
  });
  it('rejects a missing or unsigned cookie before lookup', async () => {
    signedSessionId.mockReturnValue(null);
    await expect(service.authenticate(undefined)).rejects.toBeInstanceOf(
      RealtimeUnauthenticatedError,
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects an expired, inactive, or unsupported session', async () => {
    query.mockResolvedValue([]);
    await expect(service.authenticate('sid=signed')).rejects.toBeInstanceOf(
      RealtimeUnauthenticatedError,
    );
  });
  it('does not convert a lookup failure into an authentication error', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(service.authenticate('sid=signed')).rejects.toThrow(
      'database unavailable',
    );
  });
});
