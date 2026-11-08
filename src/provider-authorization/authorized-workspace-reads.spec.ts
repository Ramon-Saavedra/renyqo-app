import { UnauthorizedException } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service';
import type { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import {
  AuthorizedWorkspaceReads,
  type SynchronousHandoff,
} from './authorized-workspace-reads';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  SessionAuthority,
} from './domain/authorization.types';

describe('Synchronous protected transport handoff', () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const workspaceId = '00000000-0000-4000-8000-000000000002';
  const authority: SessionAuthority = {
    mode: 'SESSION_BOUND',
    userId,
    authVersion: 1,
    sessionId: 'server-sid',
  };
  const requirement: AuthorizationRequirement = {
    workspaceId,
    action: 'test.read',
    resourceIds: [],
    purpose: 'OPERATIONAL',
  };
  const context: AuthorizationContext = {
    mode: 'SESSION_BOUND',
    userId,
    authVersion: 1,
    sessionId: 'server-sid',
    workspaceId,
    membershipId: '00000000-0000-4000-8000-000000000003',
    role: 'AGENT',
    status: 'ACTIVE',
    membershipRevision: 1,
    workspaceLifecycle: 'ACTIVE',
  };
  const policy = () => Promise.resolve();
  let resolve: jest.Mock<WorkspaceMembershipResolver['resolve']>;
  let reads: AuthorizedWorkspaceReads;

  beforeEach(() => {
    resolve = jest
      .fn<WorkspaceMembershipResolver['resolve']>()
      .mockResolvedValue(context);
    const resolver = {
      read: async (
        _db: unknown,
        _authority: unknown,
        _selection: unknown,
        produce: (
          context: AuthorizationContext,
          tx: object,
        ) => Promise<unknown>,
      ) => produce(await resolve({} as never, authority, requirement), {}),
    };
    reads = new AuthorizedWorkspaceReads(
      {} as PrismaService,
      resolver as unknown as WorkspaceMembershipResolver,
    );
  });

  it('accepts a synchronous enqueue with an implicit undefined return after revalidation', async () => {
    const queued: string[] = [];
    const send: SynchronousHandoff<string> = (value, current) => {
      expect(current).toEqual(context);
      queued.push(value);
    };
    await reads.handoff(authority, requirement, policy, 'payload', send);
    expect(queued).toEqual(['payload']);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('statically rejects async and ordinary Promise-returning callbacks at the API boundary', () => {
    // Compile-only calls: @ts-expect-error becomes a typecheck failure if the
    // public method ever regresses to a void-returning callback contract.
    const compileOnly = () => {
      void reads.handoff(
        authority,
        requirement,
        policy,
        'payload',
        // @ts-expect-error Async callbacks return Promise, never undefined.
        async () => {
          await Promise.resolve();
        },
      );
      void reads.handoff(
        authority,
        requirement,
        policy,
        'payload',
        // @ts-expect-error Non-async Promise-returning callbacks are also forbidden.
        () => Promise.resolve(undefined),
      );
    };
    expect(typeof compileOnly).toBe('function');
  });

  it('rejects an unchecked native async callback before invoking it or authorizing', async () => {
    let started = false;
    const send = async () => {
      started = true;
      await Promise.resolve();
    };
    await expect(
      reads.handoff(
        authority,
        requirement,
        policy,
        'payload',
        send as unknown as SynchronousHandoff<string>,
      ),
    ).rejects.toThrow('Handoff must be synchronous');
    expect(started).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'rejected'] as const)(
    'rejects an unchecked ordinary callback returning a %s Promise',
    async (state) => {
      const send = () =>
        state === 'resolved'
          ? Promise.resolve(undefined)
          : Promise.reject(new Error('invalid callback rejection'));
      await expect(
        reads.handoff(
          authority,
          requirement,
          policy,
          'payload',
          send as unknown as SynchronousHandoff<string>,
        ),
      ).rejects.toThrow('Synchronous handoff must return undefined');
      await Promise.resolve();
    },
  );

  it('rejects an unchecked non-undefined synchronous return too', async () => {
    const send = () => 'not-an-undefined-return';
    await expect(
      reads.handoff(
        authority,
        requirement,
        policy,
        'payload',
        send as unknown as SynchronousHandoff<string>,
      ),
    ).rejects.toThrow('Synchronous handoff must return undefined');
  });

  it('does not invoke the synchronous callback when final authority revalidation fails', async () => {
    resolve
      .mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new UnauthorizedException());
    const send = jest.fn<SynchronousHandoff<string>>(() => undefined);
    await expect(
      reads.handoff(authority, requirement, policy, 'payload', send),
    ).rejects.toMatchObject({ status: 401 });
    expect(send).not.toHaveBeenCalled();
  });
});
