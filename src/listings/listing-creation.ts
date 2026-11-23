import { listingLifecycleAudit } from './listing-lifecycle-audit';
import { auditedWork } from '../audit/context/audited-work';
import { assignmentAudit } from '../listing-assignments/assignment-audit';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { EntitlementResolver } from '../provider-entitlements/resolution/entitlement-resolver';
import {
  assertAcquisition,
  capacityConflict,
} from '../provider-entitlements/capacity/capacity.policy';
import { translateCapacityFailure } from '../provider-entitlements/adapters/capacity-failure';
import { providerListingWhere } from '../provider-authorization/provider-listing-access';
import { CriteriaRevisionSource } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from '../provider-authorization/protected-workspace-transactions';
import { ListingCriteriaRevisionService } from '../eligibility/listing-criteria-revision.service';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingInputRules } from './listing-input-rules';
import { ListingOrderingService } from './listing-ordering.service';

// All acquisition and replay decisions share the existing protected transaction.
@Injectable()
export class ListingCreation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly input: ListingInputRules,
    private readonly ordering: ListingOrderingService,
    private readonly criteria: ListingCriteriaRevisionService,
    private readonly entitlements: EntitlementResolver,
  ) {}

  async run(
    actor: ProviderActor,
    draft: CreateListingDto,
    commandId: string,
    responsibleMembershipId?: string,
    predecessorListingId?: string,
  ) {
    const id = randomUUID();
    const data = this.input.buildCreateData(draft);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          data,
          responsibleMembershipId: responsibleMembershipId ?? null,
          predecessorListingId: predecessorListingId ?? null,
        }),
      )
      .digest('hex');
    const requirement = {
      workspaceId: actor.workspaceId,
      action: 'listing.create',
      providerOperation: 'listing.create' as const,
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
    try {
      return await this.writes.run(
        actor.authority,
        requirement,
        {
          kind: 'STRUCTURAL',
          expectedOwnershipRevision: plan.ownershipRevision,
          membershipIds: [plan.target.id],
          userIds: [plan.target.userId],
        },
        () => Promise.resolve(),
        async (tx, ctx) =>
          auditedWork(tx, async () => {
            const prior = await tx.listingAssignmentTransition.findUnique({
              where: {
                workspaceId_commandId: {
                  workspaceId: ctx.workspaceId,
                  commandId,
                },
              },
            });
            if (prior) {
              if (
                prior.reason !== 'INITIAL' ||
                prior.initiatedByMembershipId !== ctx.membershipId ||
                prior.creationInputHash !== fingerprint
              )
                capacityConflict('CREATION_COMMAND_CONFLICT');
              const replay = await tx.listing.findFirst({
                where: { id: prior.listingId, ...providerListingWhere(ctx) },
              });
              if (!replay) throw new NotFoundException('Listing not found');
              return replay;
            }
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
            assertAcquisition(
              await this.entitlements.resolve(tx, ctx.workspaceId),
              'LISTING',
            );
            if (predecessorListingId) {
              // Current AGENT scope excludes retired history; do not widen it here.
              if (ctx.role !== 'OWNER')
                throw new NotFoundException('Listing not found');
              const predecessor = await tx.listing.findFirst({
                where: {
                  id: predecessorListingId,
                  ...providerListingWhere(ctx),
                  status: 'RETIRED',
                },
              });
              if (!predecessor)
                throw new NotFoundException('Listing not found');
              await tx.$queryRaw`SELECT id FROM listings WHERE id=${predecessorListingId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR UPDATE`;
            }
            const listing = await tx.listing.create({
              data: {
                ...data,
                id,
                workspaceId: ctx.workspaceId,
                createdByMembershipId: ctx.membershipId,
                responsibleMembershipId: plan.target.id,
                predecessorListingId,
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
                creationInputHash: fingerprint,
              },
            });
            await assignmentAudit(tx, ctx, commandId);
            await listingLifecycleAudit(
              tx,
              { kind: 'MEMBER', context: ctx },
              commandId,
              null,
              listing,
            );
            await this.criteria.current(
              tx,
              listing,
              ctx.userId,
              CriteriaRevisionSource.NATIVE,
            );
            return listing;
          }),
      );
    } catch (error) {
      translateCapacityFailure(error);
    }
  }
}
