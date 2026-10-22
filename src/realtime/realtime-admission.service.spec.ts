import { describe, expect, it, jest } from '@jest/globals';
import type { IncomingMessage } from 'node:http';
import type { ExtendedError } from 'socket.io';
import { Role } from '../generated/prisma/enums';
import {
  REALTIME_AUTH_REQUIRED_CODE,
  RealtimeAdmissionService,
} from './realtime-admission.service';
import type { RealtimeConfigService } from './realtime-config.service';
import type { RealtimeConnectionsService } from './realtime-connections.service';
import {
  RealtimeSessionService,
  RealtimeUnauthenticatedError,
  type RealtimeIdentity,
} from './realtime-session.service';

const identity: RealtimeIdentity = {
  sessionId: 'session',
  userId: 'user',
  role: Role.APPLICANT,
};

function config(
  overrides: Partial<RealtimeConfigService> = {},
): RealtimeConfigService {
  return {
    enabled: true,
    origin: 'http://localhost:3001',
    handshakeLimit: 2,
    connectionLimit: 2,
    handshakeWindowMs: 60_000,
    ...overrides,
  } as RealtimeConfigService;
}

function request(input: {
  origin?: string;
  ip?: string;
  cookie?: string;
}): IncomingMessage {
  return {
    headers: { origin: input.origin, cookie: input.cookie },
    socket: { remoteAddress: input.ip ?? '203.0.113.10' },
  } as IncomingMessage;
}

describe('Realtime handshake admission', () => {
  const authenticate =
    jest.fn<(cookie: string | undefined) => Promise<RealtimeIdentity>>();
  const add = jest.fn<(...args: unknown[]) => Promise<void>>();
  let allow: (
    request: IncomingMessage,
    done: (error: null, accepted: boolean) => void,
  ) => void = () => undefined;
  let middleware: (
    socket: { request: { headers: { cookie?: string } }; join: () => void },
    next: (error?: ExtendedError) => void,
  ) => void = () => undefined;

  function admission(overrides: Partial<RealtimeConfigService> = {}) {
    const service = new RealtimeAdmissionService(
      config(overrides),
      { authenticate } as unknown as RealtimeSessionService,
      { add } as unknown as RealtimeConnectionsService,
    );
    const opts: {
      allowRequest?: typeof allow;
    } = {};
    service.bind({
      server: {
        engine: { opts },
        of: () => ({ use: () => undefined }),
      },
      use: (fn: typeof middleware) => {
        middleware = fn;
      },
    } as never);
    allow = opts.allowRequest!;
  }

  async function accepted(input: {
    origin?: string;
    ip?: string;
    cookie?: string;
  }) {
    return new Promise<boolean>((resolve) => {
      allow(request(input), (_error, ok) => resolve(ok));
    });
  }

  async function rejected(cookie?: string) {
    const socket = {
      request: { headers: { cookie } },
      join: jest.fn(),
    };
    const error = await new Promise<ExtendedError | undefined>((resolve) => {
      middleware(socket, resolve);
    });
    return { error, socket };
  }

  it('keeps transport failures out of namespace authentication', async () => {
    admission();
    expect(
      await accepted({ origin: 'http://localhost:3001', cookie: undefined }),
    ).toBe(true);
    expect(authenticate).not.toHaveBeenCalled();

    admission({ enabled: false });
    expect(await accepted({ origin: 'http://localhost:3001' })).toBe(false);

    admission();
    expect(await accepted({ origin: 'https://evil.example' })).toBe(false);

    admission({ handshakeLimit: 1 });
    expect(
      await accepted({ origin: 'http://localhost:3001', ip: '203.0.113.4' }),
    ).toBe(true);
    expect(
      await accepted({ origin: 'http://localhost:3001', ip: '203.0.113.4' }),
    ).toBe(false);

    admission({ connectionLimit: 1, handshakeLimit: 10 });
    expect(
      await accepted({ origin: 'http://localhost:3001', ip: '203.0.113.5' }),
    ).toBe(true);
    expect(
      await accepted({ origin: 'http://localhost:3001', ip: '203.0.113.6' }),
    ).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('marks only authentication failures as AUTH_REQUIRED and does not join', async () => {
    admission();
    authenticate.mockRejectedValue(new RealtimeUnauthenticatedError());
    const auth = await rejected();
    expect(auth.error?.data).toEqual({ code: REALTIME_AUTH_REQUIRED_CODE });
    expect(REALTIME_AUTH_REQUIRED_CODE).toBe('AUTH_REQUIRED');
    expect(add).not.toHaveBeenCalled();
    expect(auth.socket.join).not.toHaveBeenCalled();

    authenticate.mockRejectedValue(new Error('database unavailable'));
    const lookup = await rejected('sid=signed');
    expect(lookup.error?.data).toBeUndefined();
    expect(lookup.socket.join).not.toHaveBeenCalled();

    authenticate.mockRejectedValue(new Error('Realtime operation timed out'));
    const timeout = await rejected('sid=signed');
    expect(timeout.error?.data).toBeUndefined();

    authenticate.mockResolvedValue(identity);
    add.mockRejectedValue(new Error('Connection limit reached'));
    const limited = await rejected('sid=signed');
    expect(limited.error?.data).toBeUndefined();
    expect(limited.socket.join).not.toHaveBeenCalled();
  });
});
