import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  sessionAuthorityFromRequest,
  captureHumanAuthority,
  assertDelegatedScope,
} from './domain/authority-reference';
import { captureRequirement } from './domain/workspace-authority.policy';
import { MembershipBootstrap } from '../provider-tenancy/membership-bootstrap';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import type {
  AuthorizationContext,
  AuthorizationRequirement,
  HumanAuthority,
} from './domain/authorization.types';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from './protected-workspace-transactions';

export interface ProviderActor {
  readonly authority: HumanAuthority;
  readonly workspaceId: string;
}

export function providerActorFromRequest(request: Request): ProviderActor {
  const workspaceId = request.header('x-workspace-id');
  if (!workspaceId) throw new NotFoundException('Workspace not found');
  return Object.freeze({
    authority: sessionAuthorityFromRequest(request),
    workspaceId,
  });
}

export function providerListingWhere(
  context: AuthorizationContext,
): Prisma.ListingWhereInput {
  return {
    workspaceId: context.workspaceId,
    ...(context.role === 'OWNER'
      ? {}
      : {
          responsibleMembershipId: context.membershipId,
          status: { not: 'RETIRED' },
        }),
  };
}

@Injectable()
export class ProviderListingAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly global: GlobalAuthorityReader,
  ) {}

  read<T>(
    actor: ProviderActor,
    action: string,
    listingId: string | undefined,
    produce: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
    ) => Promise<T>,
  ) {
    return this.readScope(
      actor,
      action,
      listingId,
      async (tx, context) => {
        if (listingId) await this.assertListing(tx, context, listingId);
        return produce(tx, context);
      },
      async (tx, context) => {
        if (listingId) await this.assertListing(tx, context, listingId);
      },
    );
  }

  private async readScope<T>(
    actor: ProviderActor,
    action: string,
    resourceId: string | undefined,
    produce: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
    ) => Promise<T>,
    revalidate: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
    ) => Promise<void>,
  ) {
    const principal = captureHumanAuthority(actor.authority);
    const requirement = captureRequirement(
      this.requirement(actor, action, resourceId),
    );
    assertDelegatedScope(principal, requirement);
    // Preserve consistent domain projections without holding authority locks.
    const snapshot = await this.prisma.$transaction(
      async (tx) => {
        await new MembershipBootstrap(this.global).enter(
          tx,
          principal,
          requirement.workspaceId,
        );
        const context = await this.resolver.resolve(tx, principal, requirement);
        return { context, value: await produce(tx, context) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    // A fresh transaction is essential: RepeatableRead cannot observe revocation
    // committed while the business projection was being assembled.
    await this.resolver.read(
      this.prisma,
      principal,
      requirement,
      async (current, tx) => {
        if (current.membershipRevision !== snapshot.context.membershipRevision)
          throw new ForbiddenException('Workspace authority changed');
        await revalidate(tx, current);
      },
    );
    return snapshot.value;
  }

  async mutate<T>(
    actor: ProviderActor,
    action: string,
    listingId: string | undefined,
    mutate: (
      tx: Prisma.TransactionClient,
      context: AuthorizationContext,
    ) => Promise<T>,
  ) {
    const requirement = this.requirement(actor, action, listingId);
    const ownershipRevision = await this.resolver.read(
      this.prisma,
      actor.authority,
      requirement,
      async (ctx, tx) => {
        if (listingId) await this.assertListing(tx, ctx, listingId);
        const w = await tx.providerWorkspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { ownershipRevision: true },
        });
        return w.ownershipRevision;
      },
    );
    return this.writes.run(
      actor.authority,
      requirement,
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: ownershipRevision,
        membershipIds: [],
      },
      async (context, tx) => {
        if (listingId) {
          await tx.$queryRaw`SELECT id FROM listings WHERE workspace_id=${context.workspaceId}::uuid AND id=${listingId}::uuid FOR UPDATE`;
          await this.assertListing(tx, context, listingId);
        }
      },
      (tx, context) => mutate(tx, context),
    );
  }

  readApplication<T>(
    actor: ProviderActor,
    action: string,
    applicationId: string,
    policy: (
      tx: Prisma.TransactionClient,
      listingId: string,
      context: AuthorizationContext,
    ) => Promise<void>,
    produce: (
      tx: Prisma.TransactionClient,
      listingId: string,
      context: AuthorizationContext,
    ) => Promise<T>,
  ) {
    let listingId: string | undefined;
    return this.readScope(
      actor,
      action,
      applicationId,
      async (tx, context) => {
        const ref = await tx.application.findUnique({
          where: { id: applicationId },
          select: { listingId: true },
        });
        if (!ref) throw new NotFoundException('Application not found');
        listingId = ref.listingId;
        await this.assertListing(tx, context, ref.listingId);
        await policy(tx, ref.listingId, context);
        return produce(tx, ref.listingId, context);
      },
      async (tx, context) => {
        const ref = await tx.application.findUnique({
          where: { id: applicationId },
          select: { listingId: true },
        });
        if (!ref || ref.listingId !== listingId)
          throw new NotFoundException('Application not found');
        await this.assertListing(tx, context, ref.listingId);
        await policy(tx, ref.listingId, context);
      },
    );
  }

  async mutateApplication<T>(
    actor: ProviderActor,
    action: string,
    applicationId: string,
    mutate: (
      tx: Prisma.TransactionClient,
      listingId: string,
      context: AuthorizationContext,
    ) => Promise<T>,
  ) {
    const listingId = await this.readApplication(
      actor,
      action,
      applicationId,
      async () => {},
      (_tx, id) => Promise.resolve(id),
    );
    return this.writes.run(
      actor.authority,
      this.requirement(actor, action, applicationId),
      { kind: 'BUSINESS' },
      async (context, tx) => {
        await tx.$queryRaw`SELECT id FROM listings WHERE id=${listingId}::uuid AND workspace_id=${context.workspaceId}::uuid FOR UPDATE`;
        await this.assertListing(tx, context, listingId);
        const ref = await tx.application.findUnique({
          where: { id: applicationId },
          select: { listingId: true },
        });
        if (!ref || ref.listingId !== listingId)
          throw new NotFoundException('Application not found');
      },
      (tx, context) => mutate(tx, listingId, context),
    );
  }

  private requirement(
    actor: ProviderActor,
    action: string,
    id?: string,
  ): AuthorizationRequirement {
    return {
      workspaceId: actor.workspaceId,
      action,
      resourceIds: id ? [id] : [],
      purpose: 'OPERATIONAL',
    };
  }

  private async assertListing(
    tx: Prisma.TransactionClient,
    context: AuthorizationContext,
    id: string,
  ) {
    const row = await tx.listing.findFirst({
      where: { id, ...providerListingWhere(context) },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Listing not found');
  }
}
