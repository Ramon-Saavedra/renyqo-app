import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipBootstrap } from '../provider-tenancy/membership-bootstrap';
import { ProviderListingAccess } from './provider-listing-access';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from './protected-workspace-transactions';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  AuthorityLockPlan,
  HumanAuthority,
  WritePolicy,
} from './domain/authorization.types';

describe('Provider application lookup boundaries', () => {
  const context: AuthorizationContext = {
    mode: 'SESSION_BOUND',
    userId: randomUUID(),
    authVersion: 1,
    workspaceId: randomUUID(),
    membershipId: randomUUID(),
    role: 'AGENT',
    status: 'ACTIVE',
    membershipRevision: 1,
    workspaceLifecycle: 'ACTIVE',
  };
  const actor = {
    workspaceId: context.workspaceId,
    authority: {
      mode: 'SESSION_BOUND' as const,
      userId: context.userId,
      authVersion: 1,
      sessionId: randomUUID(),
    },
  };
  const applicationId = randomUUID(),
    listingId = randomUUID();
  const findFirst = jest.fn();
  const lock = jest.fn();
  const tx = {
    application: { findFirst },
    $queryRaw: lock,
  } as unknown as Prisma.TransactionClient;
  let access: ProviderListingAccess;

  beforeEach(() => {
    findFirst.mockReset();
    lock.mockReset().mockResolvedValue([{ id: listingId }]);
    jest
      .spyOn(MembershipBootstrap.prototype, 'enter')
      .mockResolvedValue(context.membershipId);
    const prisma = {
      $transaction: (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => work(tx),
    } as unknown as PrismaService;
    const resolver = {
      resolve: () => Promise.resolve(context),
      read: (
        _db: unknown,
        _authority: HumanAuthority,
        _requirement: AuthorizationRequirement,
        work: (
          context: AuthorizationContext,
          tx: Prisma.TransactionClient,
        ) => Promise<unknown>,
      ) => work(context, tx),
    } as unknown as WorkspaceMembershipResolver;
    const writes = {
      run: async (
        _authority: HumanAuthority,
        requirement: AuthorizationRequirement,
        _plan: AuthorityLockPlan,
        policy: WritePolicy,
        mutate: (
          tx: Prisma.TransactionClient,
          context: AuthorizationContext,
        ) => Promise<unknown>,
      ) => {
        await policy(context, tx, requirement);
        return mutate(tx, context);
      },
    } as unknown as ProtectedWorkspaceTransactions;
    access = new ProviderListingAccess(
      prisma,
      resolver,
      writes,
      new GlobalAuthorityReader(),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['initial read', 'read revalidation', 'locked mutation'] as const)(
    'denies a missing scoped reference at %s without producing or mutating protected data',
    async (stage) => {
      const policy = jest.fn(async () => {});
      const produce = jest.fn(() => Promise.resolve('protected'));
      if (stage !== 'initial read')
        findFirst.mockResolvedValueOnce({ listingId });
      if (stage === 'locked mutation')
        findFirst.mockResolvedValueOnce({ listingId });
      findFirst.mockResolvedValue(null);
      const result =
        stage === 'locked mutation'
          ? access.mutateApplication(
              actor,
              'application.write',
              applicationId,
              produce,
            )
          : access.readApplication(
              actor,
              'application.read',
              applicationId,
              policy,
              produce,
            );
      await expect(result).rejects.toEqual(
        new NotFoundException('Application not found'),
      );
      expect(produce).toHaveBeenCalledTimes(
        stage === 'read revalidation' ? 1 : 0,
      );
      for (const [query] of findFirst.mock.calls as [
        { where: Record<string, unknown> },
      ][]) {
        expect(query.where).toMatchObject({
          id: applicationId,
          listing: {
            workspaceId: context.workspaceId,
            responsibleMembershipId: context.membershipId,
            status: { not: 'RETIRED' },
          },
        });
      }
      if (stage === 'locked mutation') {
        expect(findFirst.mock.calls[2]).toEqual([
          {
            where: {
              id: applicationId,
              listingId,
              listing: {
                workspaceId: context.workspaceId,
                responsibleMembershipId: context.membershipId,
                status: { not: 'RETIRED' },
              },
            },
            select: { listingId: true },
          },
        ]);
        expect(lock).toHaveBeenCalledTimes(1);
      }
    },
  );
});
