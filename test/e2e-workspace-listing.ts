import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../src/generated/prisma/client';
import {
  ListingAssignmentReason,
  ListingStatus,
} from '../src/generated/prisma/enums';
import type { PrismaService } from '../src/prisma/prisma.service';
import { installTenantContext } from '../src/provider-tenancy/tenant-context';
import { WorkspaceEstablishment } from '../src/provider-workspaces/workspace-establishment';
import { WorkspaceRepository } from '../src/provider-workspaces/persistence/workspace.repository';
import { MembershipIdentityRepository } from '../src/provider-workspaces/persistence/membership-identity.repository';
import { PersonalAllocationRepository } from '../src/provider-workspaces/persistence/personal-allocation.repository';
import { OrganizationProfileRepository } from '../src/provider-workspaces/persistence/organization-profile.repository';

type WorkspaceDb = PrismaService | PrismaClient;

function workspaceEstablishment() {
  return new WorkspaceEstablishment(
    new WorkspaceRepository(),
    new MembershipIdentityRepository(),
    new PersonalAllocationRepository(),
    new OrganizationProfileRepository(),
  );
}

export async function ensurePersonalWorkspaceForProvider(
  prisma: WorkspaceDb,
  providerUserId: string,
) {
  const existing = await prisma.workspaceMembership.findFirst({
    where: { userId: providerUserId, role: 'OWNER', status: 'ACTIVE' },
    select: { id: true, workspaceId: true },
  });
  if (existing) return existing;
  const establishment = workspaceEstablishment();
  const workspaceId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await installTenantContext(tx, workspaceId);
    await establishment.withinTransaction(tx, {
      workspaceId,
      membershipId: randomUUID(),
      userId: providerUserId,
      displayName: 'E2E workspace',
      kind: 'PERSONAL',
      allocationId: randomUUID(),
    });
  });
  return resolveProviderWorkspace(prisma, providerUserId);
}

export async function resolveProviderWorkspace(
  prisma: WorkspaceDb,
  providerUserId: string,
) {
  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId: providerUserId, role: 'OWNER', status: 'ACTIVE' },
    select: { id: true, workspaceId: true },
  });
  if (!membership) {
    throw new Error(
      `No active OWNER membership for provider user ${providerUserId}`,
    );
  }
  return membership;
}

export async function createPublishedListingForProvider(
  prisma: WorkspaceDb,
  providerUserId: string,
  overrides: Omit<
    Partial<Prisma.ListingCreateInput>,
    'workspace' | 'createdByMembership' | 'responsibleMembership'
  > = {},
) {
  const { workspaceId, id: membershipId } =
    await ensurePersonalWorkspaceForProvider(prisma, providerUserId);
  const maxOrder = await prisma.listing.aggregate({
    where: { workspaceId, status: { not: ListingStatus.RETIRED } },
    _max: { displayOrder: true },
  });
  const commandId = randomUUID();
  return prisma.$transaction(async (tx) => {
    await installTenantContext(tx, workspaceId);
    const workspace = await tx.providerWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { ownershipRevision: true },
    });
    await tx.$executeRaw`SELECT lock_workspace_ownership_revision(${workspaceId}::uuid, ${workspace.ownershipRevision})`;
    const {
      status: _status,
      publishedAt: overridePublishedAt,
      ...rest
    } = overrides;
    void _status;
    const listing = await tx.listing.create({
      data: {
        workspaceId,
        createdByMembershipId: membershipId,
        responsibleMembershipId: membershipId,
        displayOrder: (maxOrder._max.displayOrder ?? 0) + 1,
        status: ListingStatus.DRAFT,
        city: 'Berlin',
        title: 'E2E Test Listing',
        photos: [],
        ...rest,
      },
    });
    const publishedAt = overridePublishedAt ?? new Date();
    const published = await tx.listing.update({
      where: { id: listing.id },
      data: { status: ListingStatus.PUBLISHED, publishedAt },
    });
    await tx.listingAssignmentTransition.create({
      data: {
        id: randomUUID(),
        workspaceId,
        listingId: published.id,
        sequence: 1,
        newMembershipId: membershipId,
        reason: ListingAssignmentReason.INITIAL,
        initiatedByMembershipId: membershipId,
        commandId,
      },
    });
    return published;
  });
}

async function withWorkspaceListingLock<T>(
  prisma: WorkspaceDb,
  workspaceId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await installTenantContext(tx, workspaceId);
    const workspace = await tx.providerWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { ownershipRevision: true },
    });
    await tx.$executeRaw`SELECT lock_workspace_ownership_revision(${workspaceId}::uuid, ${workspace.ownershipRevision})`;
    return work(tx);
  });
}

async function settleListingStatus(
  tx: Prisma.TransactionClient,
  listingId: string,
  target: ListingStatus,
  publishedAt?: Date | string | null,
) {
  let listing = await tx.listing.findUniqueOrThrow({
    where: { id: listingId },
  });
  if (target === ListingStatus.DRAFT) return listing;

  const publish = async () => {
    if (listing.status === ListingStatus.DRAFT) {
      const data: Prisma.ListingUncheckedUpdateInput = {
        status: ListingStatus.PUBLISHED,
      };
      if (publishedAt === undefined) data.publishedAt = new Date();
      else if (publishedAt !== null) data.publishedAt = publishedAt;
      listing = await tx.listing.update({
        where: { id: listingId },
        data,
      });
    }
  };

  switch (target) {
    case ListingStatus.PUBLISHED:
      await publish();
      return listing;
    case ListingStatus.PAUSED:
      await publish();
      return tx.listing.update({
        where: { id: listingId },
        data: { status: ListingStatus.PAUSED },
      });
    case ListingStatus.RENTED:
      await publish();
      return tx.listing.update({
        where: { id: listingId },
        data: { status: ListingStatus.RENTED, rentedAt: new Date() },
      });
    case ListingStatus.RETIRED:
      if (listing.status === ListingStatus.DRAFT) {
        return tx.listing.update({
          where: { id: listingId },
          data: { status: ListingStatus.RETIRED },
        });
      }
      await publish();
      if (listing.status === ListingStatus.PUBLISHED) {
        return tx.listing.update({
          where: { id: listingId },
          data: { status: ListingStatus.RETIRED },
        });
      }
      return tx.listing.update({
        where: { id: listingId },
        data: { status: ListingStatus.RETIRED },
      });
    default:
      return listing;
  }
}

export async function setListingStatusForProvider(
  prisma: WorkspaceDb,
  listingId: string,
  status: ListingStatus,
  publishedAt?: Date | null,
) {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    select: { workspaceId: true },
  });
  return withWorkspaceListingLock(prisma, listing.workspaceId, (tx) =>
    settleListingStatus(tx, listingId, status, publishedAt),
  );
}

export async function compactWorkspaceListingDisplayOrder(
  prisma: WorkspaceDb,
  workspaceId: string,
) {
  return withWorkspaceListingLock(prisma, workspaceId, async (tx) => {
    const rows = await tx.listing.findMany({
      where: { workspaceId, status: { not: ListingStatus.RETIRED } },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, displayOrder: true },
    });
    if (rows.every((row, index) => row.displayOrder === index + 1)) {
      return;
    }
    const temporary =
      Math.max(0, ...rows.map((row) => row.displayOrder ?? 0)) + rows.length;
    const ids = rows.map((row) => row.id);
    for (const [index, id] of ids.entries()) {
      await tx.listing.update({
        where: { id, workspaceId },
        data: { displayOrder: temporary + index + 1 },
      });
    }
    for (const [index, id] of ids.entries()) {
      await tx.listing.update({
        where: { id, workspaceId },
        data: { displayOrder: index + 1 },
      });
    }
  });
}

export async function updateListingForProvider(
  prisma: WorkspaceDb,
  listingId: string,
  data: Prisma.ListingUncheckedUpdateInput,
) {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    select: { workspaceId: true },
  });
  return withWorkspaceListingLock(prisma, listing.workspaceId, (tx) =>
    tx.listing.update({ where: { id: listingId }, data }),
  );
}

export async function createListingInWorkspaceForProvider(
  prisma: WorkspaceDb,
  providerUserId: string,
  data: Omit<
    Prisma.ListingUncheckedCreateInput,
    'workspaceId' | 'createdByMembershipId' | 'responsibleMembershipId'
  >,
) {
  const { workspaceId, id: membershipId } =
    await ensurePersonalWorkspaceForProvider(prisma, providerUserId);
  const commandId = randomUUID();
  const { status: requestedStatus, publishedAt, ...rest } = data;
  return withWorkspaceListingLock(prisma, workspaceId, async (tx) => {
    const maxOrder = await tx.listing.aggregate({
      where: { workspaceId, status: { not: ListingStatus.RETIRED } },
      _max: { displayOrder: true },
    });
    const listing = await tx.listing.create({
      data: {
        workspaceId,
        createdByMembershipId: membershipId,
        responsibleMembershipId: membershipId,
        displayOrder: (maxOrder._max.displayOrder ?? 0) + 1,
        status: ListingStatus.DRAFT,
        photos: [],
        ...rest,
      },
    });
    await tx.listingAssignmentTransition.create({
      data: {
        id: randomUUID(),
        workspaceId,
        listingId: listing.id,
        sequence: 1,
        newMembershipId: membershipId,
        reason: ListingAssignmentReason.INITIAL,
        initiatedByMembershipId: membershipId,
        commandId,
      },
    });
    if (
      requestedStatus !== undefined &&
      requestedStatus !== ListingStatus.DRAFT
    ) {
      return settleListingStatus(tx, listing.id, requestedStatus, publishedAt);
    }
    if (publishedAt !== undefined) {
      return tx.listing.update({
        where: { id: listing.id },
        data: { publishedAt },
      });
    }
    return listing;
  });
}

/** Valid lifecycle recovery after RENTED: retire in place and publish a successor listing. */
export async function republishListingAfterRentForProvider(
  prisma: WorkspaceDb,
  providerUserId: string,
  rentedListingId: string,
) {
  await updateListingForProvider(prisma, rentedListingId, {
    status: ListingStatus.RETIRED,
  });
  return createPublishedListingForProvider(prisma, providerUserId);
}

export async function createDraftListingForProvider(
  prisma: WorkspaceDb,
  providerUserId: string,
  overrides: Omit<
    Partial<Prisma.ListingCreateInput>,
    'workspace' | 'createdByMembership' | 'responsibleMembership'
  > = {},
) {
  const { workspaceId, id: membershipId } =
    await ensurePersonalWorkspaceForProvider(prisma, providerUserId);
  const maxOrder = await prisma.listing.aggregate({
    where: { workspaceId, status: { not: ListingStatus.RETIRED } },
    _max: { displayOrder: true },
  });
  const commandId = randomUUID();
  return prisma.$transaction(async (tx) => {
    await installTenantContext(tx, workspaceId);
    const workspace = await tx.providerWorkspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { ownershipRevision: true },
    });
    await tx.$executeRaw`SELECT lock_workspace_ownership_revision(${workspaceId}::uuid, ${workspace.ownershipRevision})`;
    const listing = await tx.listing.create({
      data: {
        workspaceId,
        createdByMembershipId: membershipId,
        responsibleMembershipId: membershipId,
        displayOrder: (maxOrder._max.displayOrder ?? 0) + 1,
        status: ListingStatus.DRAFT,
        photos: [],
        ...overrides,
      },
    });
    await tx.listingAssignmentTransition.create({
      data: {
        id: randomUUID(),
        workspaceId,
        listingId: listing.id,
        sequence: 1,
        newMembershipId: membershipId,
        reason: ListingAssignmentReason.INITIAL,
        initiatedByMembershipId: membershipId,
        commandId,
      },
    });
    return listing;
  });
}
