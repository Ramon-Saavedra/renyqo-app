import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import { CriteriaRevisionSource } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import { ListingCriteriaRevisionService } from '../eligibility/listing-criteria-revision.service';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingInputRules } from './listing-input-rules';
import { ListingOrderingService } from './listing-ordering.service';

// Structural creation only. Public POST remains closed until quota/entitlement
// integration. There is deliberately no default eligibility adapter.
@Injectable()
export class ListingCreation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly input: ListingInputRules,
    private readonly ordering: ListingOrderingService,
    private readonly criteria: ListingCriteriaRevisionService,
  ) {}

  async run(
    actor: ProviderActor,
    draft: CreateListingDto,
    commandId: string,
    eligibility: (
      tx: Prisma.TransactionClient,
      workspaceId: string,
    ) => Promise<void>,
    responsibleMembershipId?: string,
  ) {
    const id = randomUUID();
    const data = this.input.buildCreateData(draft);
    const requirement = {
      workspaceId: actor.workspaceId,
      action: 'listing.create',
      resourceIds: [],
      purpose: 'OPERATIONAL' as const,
    };
    const plan = await this.resolver.read(
      this.prisma,
      actor.authority,
      requirement,
      async (ctx, tx) => {
        const targetId = responsibleMembershipId ?? ctx.membershipId;
        if (ctx.role !== 'OWNER' && targetId !== ctx.membershipId)
          throw new ForbiddenException('AGENT creation assigns itself');
        const target = await tx.workspaceMembership.findUnique({
          where: { id: targetId, workspaceId: ctx.workspaceId },
          select: { id: true, userId: true },
        });
        if (!target)
          throw new ConflictException('Responsible member is ineligible');
        const workspace = await tx.providerWorkspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { ownershipRevision: true },
        });
        return { target, ownershipRevision: workspace.ownershipRevision };
      },
    );
    return this.writes.run(
      actor.authority,
      requirement,
      {
        kind: 'STRUCTURAL',
        expectedOwnershipRevision: plan.ownershipRevision,
        membershipIds: [plan.target.id],
        userIds: [plan.target.userId],
      },
      async (ctx, tx) => {
        const target = await tx.workspaceMembership.findUnique({
          where: { id: plan.target.id, workspaceId: ctx.workspaceId },
          include: { user: { select: { status: true } } },
        });
        if (
          !target ||
          target.userId !== plan.target.userId ||
          target.status !== 'ACTIVE' ||
          target.user.status !== 'ACTIVE'
        )
          throw new ConflictException('Responsible member is ineligible');
        await eligibility(tx, ctx.workspaceId);
      },
      async (tx, ctx) => {
        const listing = await tx.listing.create({
          data: {
            ...data,
            id,
            workspaceId: ctx.workspaceId,
            createdByMembershipId: ctx.membershipId,
            responsibleMembershipId: plan.target.id,
            displayOrder: await this.ordering.getNextDisplayOrder(
              tx,
              ctx.workspaceId,
            ),
            photos: [],
          },
        });
        await tx.listingAssignmentTransition.create({
          data: {
            id: randomUUID(),
            workspaceId: ctx.workspaceId,
            listingId: id,
            sequence: 1,
            newMembershipId: plan.target.id,
            reason: 'INITIAL',
            initiatedByMembershipId: ctx.membershipId,
            commandId,
          },
        });
        await this.criteria.current(
          tx,
          listing,
          ctx.userId,
          CriteriaRevisionSource.NATIVE,
        );
        return listing;
      },
    );
  }
}
