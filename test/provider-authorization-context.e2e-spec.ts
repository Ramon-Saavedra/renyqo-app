import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { SynchronousHandoff } from '../src/provider-authorization/authorized-workspace-reads';
import {
  AuthorizationFixture,
  deferred,
} from './provider-authorization.fixture';
import { delegateContext } from '../src/provider-authorization/domain/authority-reference';
import { requireVisibleWorkspaceResource } from '../src/provider-authorization/domain/resource-visibility';
import type { HumanAuthority } from '../src/provider-authorization/domain/authorization.types';

jest.setTimeout(30000);
describe('Current workspace authorization (PostgreSQL)', () => {
  const f = new AuthorizationFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  it('resolves canonical ACTIVE membership without global PROVIDER role or business/profile fields', async () => {
    const s = await f.subject();
    expect(
      (
        await f.prisma.user.findUniqueOrThrow({
          where: { id: s.authority.userId },
        })
      ).role,
    ).toBe('APPLICANT');
    const context = await f.resolver.resolve(f.prisma, s.authority, s.request);
    expect(context).toEqual({
      mode: 'SESSION_BOUND',
      userId: s.authority.userId,
      authVersion: 1,
      sessionId: s.authority.sessionId,
      workspaceId: s.w.id,
      membershipId: s.membershipId,
      role: 'AGENT',
      status: 'ACTIVE',
      membershipRevision: 1,
      workspaceLifecycle: 'ACTIVE',
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'denies %s membership without changing global identity',
    async (status) => {
      const s = await f.subject();
      await f.change(s.w.id, s.membershipId, status);
      await expect(
        f.resolver.resolve(f.prisma, s.authority, s.request),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (
          await f.prisma.user.findUniqueOrThrow({
            where: { id: s.authority.userId },
          })
        ).authVersion,
      ).toBe(1);
    },
  );

  it('denies wrong workspace, spoofed membership and absent membership without selecting another tenant', async () => {
    const s = await f.subject();
    const other = await f.organization();
    for (const requirement of [
      { ...s.request, workspaceId: other.id },
      { ...s.request, expectedMembershipId: s.w.agents[1].id },
      { ...s.request, workspaceId: randomUUID() },
    ])
      await expect(
        f.resolver.resolve(f.prisma, s.authority, requirement),
      ).rejects.toMatchObject({ status: 404 });
  });

  it('normalizes UUID selection and rejects malformed identity/selection before SQL casts', async () => {
    const s = await f.subject();
    expect(
      await f.resolver.resolve(f.prisma, s.authority, {
        ...s.request,
        workspaceId: s.w.id.toUpperCase(),
      }),
    ).toMatchObject({ workspaceId: s.w.id });
    await expect(
      f.resolver.resolve(f.prisma, s.authority, {
        ...s.request,
        workspaceId: 'invalid',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.resolver.resolve(
        f.prisma,
        { ...s.authority, userId: 'invalid' },
        s.request,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(['SUSPENDED', 'DELETED'] as const)(
    'denies global %s account',
    async (status) => {
      const s = await f.subject();
      await f.prisma.user.update({
        where: { id: s.authority.userId },
        data: { status },
      });
      await expect(
        f.resolver.resolve(f.prisma, s.authority, s.request),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it('denies stale authVersion', async () => {
    const s = await f.subject();
    await f.prisma.user.update({
      where: { id: s.authority.userId },
      data: { authVersion: { increment: 1 } },
    });
    await expect(
      f.resolver.resolve(f.prisma, s.authority, s.request),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    'MISSING',
    'EXPIRED',
    'WRONG_USER',
    'WRONG_VERSION',
    'WRONG_SNAPSHOT',
  ] as const)('denies %s durable session authority', async (kind) => {
    const s = await f.subject();
    if (kind === 'MISSING')
      await f.prisma.sessionAuthGrant.delete({
        where: { sid: s.authority.sessionId },
      });
    if (kind === 'EXPIRED')
      await f.prisma.userSession.update({
        where: { sid: s.authority.sessionId },
        data: { expire: new Date(0) },
      });
    if (kind === 'WRONG_USER') s.authority = await f.session(await f.user());
    if (kind === 'WRONG_VERSION')
      await f.prisma.sessionAuthGrant.update({
        where: { sid: s.authority.sessionId },
        data: { authVersion: 2 },
      });
    if (kind === 'WRONG_SNAPSHOT')
      await f.prisma.userSession.update({
        where: { sid: s.authority.sessionId },
        data: {
          sess: {
            passport: { user: { id: s.authority.userId, authVersion: '1' } },
          },
        },
      });
    const authority =
      kind === 'WRONG_USER'
        ? { ...s.authority, userId: s.w.agents[0].userId }
        : s.authority;
    await expect(
      f.resolver.resolve(f.prisma, authority, s.request),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not revive a revoked grant when stale physical session data is recreated', async () => {
    const s = await f.subject();
    await f.prisma.userSession.delete({
      where: { sid: s.authority.sessionId },
    });
    await f.prisma.userSession.create({
      data: {
        sid: s.authority.sessionId,
        expire: new Date(Date.now() + 60000),
        sess: {
          passport: { user: { id: s.authority.userId, authVersion: 1 } },
        },
      },
    });
    await expect(
      f.resolver.resolve(f.prisma, s.authority, s.request),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('invalidates an old membership epoch even after suspension/resume returns to ACTIVE', async () => {
    const s = await f.subject();
    await f.change(s.w.id, s.membershipId, 'SUSPENDED');
    await f.change(s.w.id, s.membershipId, 'ACTIVE');
    await expect(
      f.resolver.resolve(f.prisma, s.authority, s.request),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await f.resolver.resolve(f.prisma, s.authority, {
        ...s.request,
        expectedMembershipRevision: 3,
      }),
    ).toMatchObject({ membershipRevision: 3 });
  });

  it('rejects stale role authority and OWNER requirements independently of global role', async () => {
    const s = await f.subject(true);
    await f.sqlTransaction(async (c) => {
      await f.lock(c, s.w.id);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [s.membershipId],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [s.w.agents[0].id],
      );
    });
    await expect(f.mutate(s.authority, s.request)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      f.resolver.resolve(f.prisma, s.authority, {
        ...s.request,
        expectedMembershipRevision: 2,
        requiredRole: 'OWNER',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('binds ownershipRevision only when requested, while ordinary AGENT authority may survive an owner swap', async () => {
    const s = await f.subject();
    await f.sqlTransaction(async (c) => {
      await f.lock(c, s.w.id);
      await c.query(
        `UPDATE workspace_memberships SET role='AGENT' WHERE id=$1`,
        [s.w.owner],
      );
      await c.query(
        `UPDATE workspace_memberships SET role='OWNER' WHERE id=$1`,
        [s.w.agents[1].id],
      );
    });
    await expect(
      f.resolver.resolve(f.prisma, s.authority, {
        ...s.request,
        expectedOwnershipRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await f.resolver.resolve(f.prisma, s.authority, s.request),
    ).not.toHaveProperty('ownershipRevision');
  });

  it('allows one identity in two workspaces and keeps membership revocation scoped', async () => {
    const s = await f.subject();
    const other = await f.organization();
    const m = await f.prisma.workspaceMembership.create({
      data: {
        workspaceId: other.id,
        userId: s.authority.userId,
        role: 'AGENT',
        displayColor: '#123456',
      },
    });
    const selection = {
      ...s.request,
      workspaceId: other.id,
      expectedMembershipId: m.id,
    };
    expect(
      await f.resolver.resolve(f.prisma, s.authority, selection),
    ).toMatchObject({ workspaceId: other.id });
    await f.change(s.w.id, s.membershipId, 'REMOVED');
    await expect(
      f.resolver.resolve(f.prisma, s.authority, s.request),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await f.resolver.resolve(f.prisma, s.authority, selection),
    ).toMatchObject({ membershipId: m.id });
  });

  it('enforces explicit CLOSING/CLOSED categories without blanket history grants', async () => {
    const s = await f.subject();
    await f.tx((tx) =>
      f.lifecycle.beginClosingWithinTransaction(tx, s.w.id, 1),
    );
    await expect(
      f.resolver.resolve(f.prisma, s.authority, s.request),
    ).rejects.toMatchObject({ status: 403 });
    for (const purpose of [
      'HISTORY',
      'SECURITY',
      'CLOSURE_SETTLEMENT',
    ] as const)
      expect(
        await f.resolver.resolve(f.prisma, s.authority, {
          ...s.request,
          purpose,
        }),
      ).toMatchObject({ workspaceLifecycle: 'CLOSING' });
    await f.tx((tx) =>
      f.lifecycle.completeClosureWithinTransaction(tx, s.w.id, 2),
    );
    for (const purpose of ['OPERATIONAL', 'CLOSURE_SETTLEMENT'] as const)
      await expect(
        f.resolver.resolve(f.prisma, s.authority, { ...s.request, purpose }),
      ).rejects.toMatchObject({ status: 403 });
    const policy = jest.fn(() =>
      Promise.reject(new Error('Domain history denied')),
    );
    await expect(
      f.reads.query(
        s.authority,
        { ...s.request, purpose: 'HISTORY' },
        policy,
        () => Promise.resolve('secret'),
      ),
    ).rejects.toThrow('Domain history denied');
  });

  it('USER_DELEGATED survives browser logout while SESSION_BOUND does not', async () => {
    const s = await f.subject();
    const context = await f.resolver.resolve(f.prisma, s.authority, s.request);
    const delegated = delegateContext(context, s.request);
    expect(delegated).not.toHaveProperty('sessionId');
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: s.authority.sessionId },
    });
    await expect(f.mutate(s.authority, s.request)).rejects.toMatchObject({
      status: 401,
    });
    expect(await f.mutate(delegated, s.request)).toBe(1);
  });

  it.each(['GLOBAL', 'MEMBERSHIP'] as const)(
    'USER_DELEGATED stops on relevant %s epoch change',
    async (kind) => {
      const s = await f.subject();
      const delegated = delegateContext(
        await f.resolver.resolve(f.prisma, s.authority, s.request),
        s.request,
      );
      if (kind === 'GLOBAL')
        await f.prisma.user.update({
          where: { id: s.authority.userId },
          data: { authVersion: { increment: 1 } },
        });
      else {
        await f.change(s.w.id, s.membershipId, 'SUSPENDED');
        await f.change(s.w.id, s.membershipId, 'ACTIVE');
      }
      await expect(f.mutate(delegated, s.request)).rejects.toBeDefined();
      expect(await f.value(s.resourceId)).toBe(0);
    },
  );

  it('rejects delegated action/resource/tenant broadening and SYSTEM substitution', async () => {
    const s = await f.subject();
    const delegated = delegateContext(
      await f.resolver.resolve(f.prisma, s.authority, s.request),
      s.request,
    );
    for (const request of [
      { ...s.request, action: 'test.other' },
      { ...s.request, resourceIds: [randomUUID()] },
      { ...s.request, resourceIds: [] },
      { ...s.request, workspaceId: randomUUID() },
    ])
      await expect(f.mutate(delegated, request)).rejects.toMatchObject({
        status: 403,
      });
    await expect(async () =>
      f.mutate(
        {
          mode: 'SYSTEM',
          purpose: 'pretend',
          workspaceId: s.w.id,
          scope: s.request,
        } as unknown as HumanAuthority,
        s.request,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('makes foreign and nonexistent canonical resources indistinguishable', async () => {
    const s = await f.subject();
    const other = await f.subject();
    const context = await f.resolver.resolve(f.prisma, s.authority, s.request);
    for (const id of [randomUUID(), other.resourceId]) {
      // Minimal server-side tenant routing reference; never expose this row.
      const resource =
        (
          await f.pool.query<{ id: string; workspaceId: string }>(
            'SELECT id,workspace_id AS "workspaceId" FROM authz_test_resources WHERE id=$1',
            [id],
          )
        ).rows[0] ?? null;
      try {
        requireVisibleWorkspaceResource(context, resource);
        throw new Error('unexpected allow');
      } catch (error) {
        expect(error).toMatchObject({
          status: 404,
          message: 'Resource not found',
        });
      }
    }
  });

  it('revalidates after async read policy work before protected result production', async () => {
    const s = await f.subject();
    const entered = deferred();
    const release = deferred();
    const produce = jest.fn(() => Promise.resolve('secret'));
    const read = f.reads.query(
      s.authority,
      s.request,
      async () => {
        entered.resolve();
        await release.promise;
      },
      produce,
    );
    const outcome = read.then(
      () => null,
      (error) => error as unknown,
    );
    await entered.promise;
    await f.change(s.w.id, s.membershipId, 'SUSPENDED');
    release.resolve();
    expect(await outcome).toMatchObject({ status: 404 });
    expect(produce).not.toHaveBeenCalled();
  });

  it('performs a synchronous handoff after current PostgreSQL authority validation', async () => {
    const s = await f.subject();
    const sent: string[] = [];
    const send: SynchronousHandoff<string> = (value, context) => {
      expect(context.membershipId).toBe(s.membershipId);
      sent.push(value);
    };
    await f.reads.handoff(
      s.authority,
      s.request,
      () => Promise.resolve(),
      'protected result',
      send,
    );
    expect(sent).toEqual(['protected result']);
  });

  it('revalidates sensitive transport handoff and every subsequent read/page', async () => {
    const s = await f.subject();
    const policy = async () => {};
    const result = await f.reads.query(s.authority, s.request, policy, () =>
      Promise.resolve('protected result'),
    );
    await f.prisma.sessionAuthGrant.delete({
      where: { sid: s.authority.sessionId },
    });
    const send = jest.fn<SynchronousHandoff<string>>(() => undefined);
    await expect(
      f.reads.handoff(s.authority, s.request, policy, result, send),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.reads.query(s.authority, s.request, policy, () =>
        Promise.resolve(result),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
  });
});
