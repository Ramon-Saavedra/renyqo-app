import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceMembershipResolver } from '../provider-authorization/workspace-membership.resolver';
import type {
  AuthorizationRequirement,
  HumanAuthority,
} from '../provider-authorization/domain/authorization.types';

// Routing/discovery only; the write transaction revalidates every mapping after
// locking all declared global Users before workspace/membership/listing locks.
@Injectable()
export class AssignmentParticipants {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
  ) {}

  discover(
    authority: HumanAuthority,
    requirement: AuthorizationRequirement,
    listingId: string,
    targetId: string,
    additionalIds: readonly string[] = [],
  ) {
    return this.resolver.read(
      this.prisma,
      authority,
      requirement,
      async (context, tx) => {
        const listing = await tx.$queryRaw<
          { responsible_membership_id: string }[]
        >`
        SELECT responsible_membership_id FROM listings WHERE id=${listingId}::uuid AND workspace_id=${context.workspaceId}::uuid`;
        if (!listing[0]) throw new NotFoundException('Listing not found');
        if (
          context.role !== 'OWNER' &&
          context.membershipId !== listing[0].responsible_membership_id
        )
          throw new NotFoundException('Listing not found');
        const ids = [
          ...new Set([
            context.membershipId,
            listing[0].responsible_membership_id,
            targetId,
            ...additionalIds,
          ]),
        ];
        const members = await tx.workspaceMembership.findMany({
          where: { workspaceId: context.workspaceId, id: { in: ids } },
          select: { id: true, userId: true },
        });
        if (members.length !== ids.length)
          throw new NotFoundException('Listing not found');
        const workspace = await tx.providerWorkspace.findUniqueOrThrow({
          where: { id: context.workspaceId },
          select: { ownershipRevision: true },
        });
        return {
          sourceId: listing[0].responsible_membership_id,
          members,
          ownershipRevision: workspace.ownershipRevision,
        };
      },
    );
  }
}
