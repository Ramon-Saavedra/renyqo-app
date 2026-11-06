import { WorkspaceFixture } from './provider-workspaces.fixture';

jest.setTimeout(30000);

describe('Provider workspace foundation (isolated PostgreSQL schema)', () => {
  const f = new WorkspaceFixture();
  beforeAll(() => f.start());
  afterAll(() => f.stop());

  it('establishes PERSONAL atomically with one canonical owner and allocation', async () => {
    const input = f.command(await f.user());
    const workspace = await f.establish(input);
    expect(workspace).toMatchObject({
      id: input.workspaceId,
      kind: 'PERSONAL',
      lifecycleStatus: 'ACTIVE',
      revision: 1,
      ownershipRevision: 1,
      closingAt: null,
      closedAt: null,
    });
    const members = await f.prisma.workspaceMembership.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      id: input.membershipId,
      role: 'OWNER',
      userId: input.userId,
      displayColor: '#2563EB',
    });
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { workspaceId: workspace.id, releasedAt: null },
      }),
    ).toBe(1);
  });

  it('establishes ORGANIZATION with a separate profile and no personal reservation', async () => {
    const input = f.command(await f.user(), 'ORGANIZATION');
    const workspace = await f.establish(input);
    expect(
      await f.prisma.organizationProfile.findUnique({
        where: { workspaceId: workspace.id },
      }),
    ).toMatchObject({ legalName: 'Agency GmbH', revision: 1 });
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { workspaceId: workspace.id },
      }),
    ).toBe(0);
  });

  it('permits multiple organization workspaces per global user', async () => {
    const user = await f.user();
    await f.establish(f.command(user, 'ORGANIZATION'));
    await f.establish(f.command(user, 'ORGANIZATION'));
    expect(
      await f.prisma.workspaceMembership.count({
        where: { userId: user, role: 'OWNER' },
      }),
    ).toBe(2);
  });

  it('deduplicates establishment and rejects conflicting reuse of its identity', async () => {
    const input = f.command(await f.user());
    const [a, b] = await Promise.all([f.establish(input), f.establish(input)]);
    expect(a.id).toBe(b.id);
    expect(
      await f.prisma.workspaceMembership.count({
        where: { workspaceId: a.id },
      }),
    ).toBe(1);
    await expect(
      f.establish({ ...input, displayName: 'Different' }),
    ).rejects.toThrow();
  });

  it('allows exactly one winner under concurrent personal allocation and rolls back the loser', async () => {
    const user = await f.user();
    const inputs = [f.command(user), f.command(user)];
    const results = await Promise.allSettled(
      inputs.map((input) => f.establish(input)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await f.prisma.workspaceMembership.count({ where: { userId: user } }),
    ).toBe(1);
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: user, releasedAt: null },
      }),
    ).toBe(1);
    expect(
      await f.prisma.providerWorkspace.count({
        where: { id: { in: inputs.map((i) => i.workspaceId) } },
      }),
    ).toBe(1);
  });

  it('keeps CLOSING reserved, releases exactly once at CLOSED and permits historical allocations', async () => {
    const user = await f.user();
    const input = f.command(user);
    await f.establish(input);
    const closing = await f.tx((tx) =>
      f.lifecycle.beginClosingWithinTransaction(tx, input.workspaceId, 1),
    );
    const retried = await f.tx((tx) =>
      f.lifecycle.beginClosingWithinTransaction(tx, input.workspaceId, 1),
    );
    expect(retried.revision).toBe(closing.revision);
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: user, releasedAt: null },
      }),
    ).toBe(1);
    await expect(f.establish(f.command(user))).rejects.toThrow();
    const closed = await f.tx((tx) =>
      f.lifecycle.completeClosureWithinTransaction(tx, input.workspaceId, 2),
    );
    await f.tx((tx) =>
      f.lifecycle.completeClosureWithinTransaction(tx, input.workspaceId, 2),
    );
    const allocation =
      await f.prisma.personalWorkspaceAllocation.findFirstOrThrow({
        where: { workspaceId: input.workspaceId },
      });
    expect(allocation.releasedAt).toEqual(closed.closedAt);
    expect(allocation.releaseReason).toBe('WORKSPACE_CLOSED');
    // Internal persistence test, not an anti-abuse eligibility approval.
    await f.establish(f.command(user));
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: user },
      }),
    ).toBe(2);
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: user, releasedAt: null },
      }),
    ).toBe(1);
  });

  it('converts the same workspace and preserves membership/color/allocation; retries are safe', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    const before = await f.prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: input.membershipId },
    });
    const args = {
      workspaceId: input.workspaceId,
      expectedRevision: 1,
      legalName: 'New Agency',
    };
    const converted = await f.tx((tx) =>
      f.conversion.withinTransaction(tx, args),
    );
    await expect(
      f.tx((tx) => f.conversion.withinTransaction(tx, args)),
    ).rejects.toThrow('revision');
    expect(converted).toMatchObject({
      id: input.workspaceId,
      kind: 'ORGANIZATION',
      revision: 2,
      ownershipRevision: 1,
    });
    expect(
      await f.prisma.workspaceMembership.findUnique({
        where: { id: before.id },
      }),
    ).toEqual(before);
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { userId: input.userId, releasedAt: null },
      }),
    ).toBe(1);
    await expect(f.establish(f.command(input.userId))).rejects.toThrow();
    await f.close(converted.id, 2);
    await f.establish(f.command(input.userId));
  });

  it('rejects stale/conflicting conversions and never leaves a partial profile', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await expect(
      f.tx((tx) =>
        f.conversion.withinTransaction(tx, {
          workspaceId: input.workspaceId,
          expectedRevision: 2,
          legalName: 'Stale',
        }),
      ),
    ).rejects.toThrow('revision');
    expect(
      await f.prisma.organizationProfile.count({
        where: { workspaceId: input.workspaceId },
      }),
    ).toBe(0);
    await f.tx((tx) =>
      f.conversion.withinTransaction(tx, {
        workspaceId: input.workspaceId,
        expectedRevision: 1,
        legalName: null,
      }),
    );
    await expect(
      f.tx((tx) =>
        f.conversion.withinTransaction(tx, {
          workspaceId: input.workspaceId,
          expectedRevision: 1,
          legalName: 'Conflicting',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects lifecycle skips, stale revisions and reopening CLOSED', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await expect(
      f.tx((tx) =>
        f.lifecycle.completeClosureWithinTransaction(tx, input.workspaceId, 1),
      ),
    ).rejects.toThrow('CLOSING');
    await expect(
      f.tx((tx) =>
        f.lifecycle.beginClosingWithinTransaction(tx, input.workspaceId, 2),
      ),
    ).rejects.toThrow('revision');
    await f.close(input.workspaceId);
    await expect(
      f.tx((tx) =>
        f.lifecycle.beginClosingWithinTransaction(tx, input.workspaceId, 3),
      ),
    ).rejects.toThrow('ACTIVE');
    await expect(
      f.prisma.providerWorkspace.update({
        where: { id: input.workspaceId },
        data: {
          lifecycleStatus: 'ACTIVE',
          closingAt: null,
          closedAt: null,
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects early release, inconsistent release fields and released-history mutation', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await expect(
      f.tx(async (tx) => {
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${input.workspaceId}::uuid, 1)`;
        return tx.personalWorkspaceAllocation.updateMany({
          where: { workspaceId: input.workspaceId },
          data: { releasedAt: new Date(), releaseReason: 'WORKSPACE_CLOSED' },
        });
      }),
    ).rejects.toThrow('Allocation releases only on full workspace closure');
    await f.close(input.workspaceId);
    await expect(
      f.tx(async (tx) => {
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${input.workspaceId}::uuid, 1)`;
        return tx.personalWorkspaceAllocation.updateMany({
          where: { workspaceId: input.workspaceId },
          data: { releasedAt: null, releaseReason: null },
        });
      }),
    ).rejects.toThrow();
    await expect(
      f.tx(async (tx) => {
        await tx.$queryRaw`SELECT lock_workspace_ownership_revision(${input.workspaceId}::uuid, 1)`;
        return tx.personalWorkspaceAllocation.updateMany({
          where: { workspaceId: input.workspaceId },
          data: { releaseReason: null },
        });
      }),
    ).rejects.toThrow();
  });

  it('rolls back allocation release when surrounding closure settlement fails', async () => {
    const input = f.command(await f.user());
    await f.establish(input);
    await f.tx((tx) =>
      f.lifecycle.beginClosingWithinTransaction(tx, input.workspaceId, 1),
    );
    await expect(
      f.tx(async (tx) => {
        await f.lifecycle.completeClosureWithinTransaction(
          tx,
          input.workspaceId,
          2,
        );
        throw new Error('Required evidence failed');
      }),
    ).rejects.toThrow('Required evidence failed');
    expect(
      await f.prisma.providerWorkspace.findUnique({
        where: { id: input.workspaceId },
      }),
    ).toMatchObject({ lifecycleStatus: 'CLOSING', revision: 2 });
    expect(
      await f.prisma.personalWorkspaceAllocation.count({
        where: { workspaceId: input.workspaceId, releasedAt: null },
      }),
    ).toBe(1);
  });
});
