import request from 'supertest';
import { Socket as ServerSocket } from 'socket.io';
import type { Socket } from 'socket.io-client';
import { Role, UserStatus } from '../src/generated/prisma/enums';
import { PasswordResetTokensRepository } from '../src/auth/password-reset-tokens.repository';
import { RealtimeSessionService } from '../src/realtime/realtime-session.service';
import { randomUUID } from 'node:crypto';
import { realtimeTestApp, connected, disconnected } from './realtime-test-app';

type HandshakeError = Error & { data?: { code?: string } };

function handshakeError(socket: Socket): Promise<HandshakeError> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () =>
      reject(new Error('expected handshake to fail')),
    );
    socket.once('connect_error', (error: Error) =>
      resolve(error as HandshakeError),
    );
    socket.connect();
  });
}

describe('Realtime session security', () => {
  let context: Awaited<ReturnType<typeof realtimeTestApp>>;
  beforeAll(async () => {
    context = await realtimeTestApp();
  });
  afterAll(async () => {
    await context?.close();
  });

  it('accepts the existing signed session and ignores spoofed identity', async () => {
    const owner = await context.user();
    const socket = context.client(owner.cookie, undefined, {
      userId: 'another-user',
      role: 'PROVIDER',
    });
    await connected(socket);
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it.each(['missing', 'tampered', 'expired', 'deleted'])(
    'rejects %s sessions with AUTH_REQUIRED',
    async (kind) => {
      const owner = await context.user();
      if (kind === 'expired')
        await context.prisma.userSession.update({
          where: { sid: owner.id },
          data: { expire: new Date(0) },
        });
      if (kind === 'deleted')
        await context.prisma.userSession.delete({ where: { sid: owner.id } });
      const cookie =
        kind === 'missing'
          ? undefined
          : kind === 'tampered'
            ? owner.cookie + 'x'
            : owner.cookie;
      const join = jest.spyOn(ServerSocket.prototype, 'join');
      try {
        const error = await handshakeError(context.client(cookie));
        expect(error.data).toEqual({ code: 'AUTH_REQUIRED' });
        expect(join).not.toHaveBeenCalled();
      } finally {
        join.mockRestore();
      }
    },
  );

  it.each([
    ['suspended', UserStatus.SUSPENDED],
    ['deleted', UserStatus.DELETED],
  ] as const)(
    'rejects a %s account with AUTH_REQUIRED',
    async (_label, status) => {
      const owner = await context.user();
      await context.prisma.user.update({
        where: { id: owner.userId },
        data: { status },
      });
      const error = await handshakeError(context.client(owner.cookie));
      expect(error.data).toEqual({ code: 'AUTH_REQUIRED' });
    },
  );

  it('rejects an unsupported role with AUTH_REQUIRED', async () => {
    const owner = await context.user(Role.ADMIN);
    const error = await handshakeError(context.client(owner.cookie));
    expect(error.data).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it.each(['https://evil.example', null, 'http://localhost:3001.evil.example'])(
    'rejects origin %s without AUTH_REQUIRED',
    async (origin) => {
      const owner = await context.user();
      const error = await handshakeError(context.client(owner.cookie, origin));
      expect(error.data?.code).toBeUndefined();
    },
  );

  it('disconnects arbitrary join and domain mutation attempts', async () => {
    for (const event of ['join', 'conversation.send']) {
      const owner = await context.user();
      const socket = context.client(owner.cookie);
      await connected(socket);
      const ended = disconnected(socket);
      socket.emit(event, 'user:someone-else');
      await ended;
    }
  });

  it('rejects connections above the session limit', async () => {
    const owner = await context.user();
    const first = context.client(owner.cookie);
    const second = context.client(owner.cookie);
    await connected(first);
    await connected(second);
    const join = jest.spyOn(ServerSocket.prototype, 'join');
    try {
      const error = await handshakeError(context.client(owner.cookie));
      expect(error.data?.code).toBeUndefined();
      expect(join).not.toHaveBeenCalled();
    } finally {
      join.mockRestore();
    }
    first.disconnect();
    second.disconnect();
  });

  it('does not use AUTH_REQUIRED when realtime is disabled', async () => {
    const disabled = await realtimeTestApp({ enabled: false });
    try {
      const owner = await disabled.user();
      const error = await handshakeError(disabled.client(owner.cookie));
      expect(error.data?.code).toBeUndefined();
    } finally {
      await disabled.close();
    }
  });

  it('does not use AUTH_REQUIRED for rate or connection limits', async () => {
    const limited = await realtimeTestApp({
      handshakeLimit: 2,
      connectionLimit: 1,
      sessionLimit: 5,
    });
    try {
      const first = await limited.user();
      const second = await limited.user();
      const socket = limited.client(first.cookie);
      await connected(socket);
      const capped = await handshakeError(limited.client(second.cookie));
      expect(capped.data?.code).toBeUndefined();
      const rated = await handshakeError(limited.client(first.cookie));
      expect(rated.data?.code).toBeUndefined();
      socket.disconnect();
    } finally {
      await limited.close();
    }
  });

  it.each(['database unavailable', 'Realtime operation timed out'])(
    'does not use AUTH_REQUIRED when session lookup fails (%s)',
    async (message) => {
      const owner = await context.user();
      const sessions = context.app.get(RealtimeSessionService);
      const valid = jest
        .spyOn(sessions, 'valid')
        .mockRejectedValue(new Error(message));
      try {
        const error = await handshakeError(context.client(owner.cookie));
        expect(error.data?.code).toBeUndefined();
      } finally {
        valid.mockRestore();
      }
    },
  );

  it('logout invalidates only the affected session', async () => {
    const owner = await context.user();
    const other = await context.sessionFor(owner.userId);
    const first = context.client(owner.cookie);
    const second = context.client(other.cookie);
    await connected(first);
    await connected(second);
    const ended = disconnected(first);
    await request(context.url)
      .post('/api/v1/auth/logout')
      .set('Cookie', owner.cookie)
      .expect(200);
    await ended;
    expect(second.connected).toBe(true);
    second.disconnect();
  });

  it.each(['delete', 'expire', 'disable', 'deleted-account'])(
    'revokes a connected session after %s',
    async (action) => {
      const owner = await context.user();
      const socket = context.client(owner.cookie);
      await connected(socket);
      const ended = disconnected(socket);
      if (action === 'delete')
        await context.prisma.userSession.delete({ where: { sid: owner.id } });
      if (action === 'expire')
        await context.prisma.userSession.update({
          where: { sid: owner.id },
          data: { expire: new Date(0) },
        });
      if (action === 'disable')
        await context.prisma.user.update({
          where: { id: owner.userId },
          data: { status: UserStatus.SUSPENDED },
        });
      if (action === 'deleted-account')
        await context.prisma.user.update({
          where: { id: owner.userId },
          data: { status: UserStatus.DELETED },
        });
      await ended;
      expect(socket.connected).toBe(false);
    },
  );

  it('rejects the default namespace without AUTH_REQUIRED', async () => {
    const owner = await context.user();
    const error = await handshakeError(
      context.client(owner.cookie, undefined, {}, 'default'),
    );
    expect(error.data?.code).toBeUndefined();
  });

  it('rejects polling transport without AUTH_REQUIRED', async () => {
    const owner = await context.user();
    const error = await handshakeError(
      context.client(owner.cookie, undefined, {}, 'realtime', ['polling']),
    );
    expect(error.data?.code).toBeUndefined();
  });

  it('does not create or touch sessions on connection and revalidation', async () => {
    const owner = await context.user();
    const before = await context.prisma.userSession.findUniqueOrThrow({
      where: { sid: owner.id },
    });
    const count = await context.prisma.userSession.count();
    const socket = context.client(owner.cookie);
    await connected(socket);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    expect(await context.prisma.userSession.count()).toBe(count);
    expect(
      await context.prisma.userSession.findUniqueOrThrow({
        where: { sid: owner.id },
      }),
    ).toEqual(before);
    socket.disconnect();
  });

  it('password reset disconnects every invalidated session for the user', async () => {
    const owner = await context.user();
    const other = await context.sessionFor(owner.userId);
    const first = context.client(owner.cookie),
      second = context.client(other.cookie);
    await Promise.all([connected(first), connected(second)]);
    const ended = Promise.all([disconnected(first), disconnected(second)]);
    const tokenHash = randomUUID();
    await context.prisma.passwordResetToken.create({
      data: {
        userId: owner.userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    expect(
      await context.app
        .get(PasswordResetTokensRepository)
        .consumeValidTokenAndUpdatePassword({
          tokenHash,
          passwordHash: 'reset-test-hash',
          now: new Date(),
        }),
    ).toBe(true);
    await ended;
    expect(first.connected || second.connected).toBe(false);
  });
});
