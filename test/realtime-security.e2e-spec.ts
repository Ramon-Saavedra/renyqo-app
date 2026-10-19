import request from 'supertest';
import { UserStatus } from '../src/generated/prisma/enums';
import { PasswordResetTokensRepository } from '../src/auth/password-reset-tokens.repository';
import { randomUUID } from 'node:crypto';
import { realtimeTestApp, connected, disconnected } from './realtime-test-app';

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
    'rejects %s sessions',
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
      await expect(connected(context.client(cookie))).rejects.toBeInstanceOf(
        Error,
      );
    },
  );

  it.each(['https://evil.example', null, 'http://localhost:3001.evil.example'])(
    'rejects origin %s',
    async (origin) => {
      const owner = await context.user();
      await expect(
        connected(context.client(owner.cookie, origin)),
      ).rejects.toBeInstanceOf(Error);
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
    await expect(
      connected(context.client(owner.cookie)),
    ).rejects.toBeInstanceOf(Error);
    first.disconnect();
    second.disconnect();
  });

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

  it('rejects the default namespace', async () => {
    const owner = await context.user();
    await expect(
      connected(context.client(owner.cookie, undefined, {}, 'default')),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects polling transport', async () => {
    const owner = await context.user();
    await expect(
      connected(
        context.client(owner.cookie, undefined, {}, 'realtime', ['polling']),
      ),
    ).rejects.toBeInstanceOf(Error);
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
