import { Injectable } from '@nestjs/common';
import { AuthorizedWorkspaceReads } from '../../provider-authorization/authorized-workspace-reads';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import { ListingCreationAvailabilityProjection } from '../../provider-entitlements/projections/listing-creation-availability';
import { isMemberColor } from '../../member-presentation/member-color.catalog';
import type { CurrentWorkspaceDto } from './current-workspace.dto';

@Injectable()
export class CurrentWorkspaceQuery {
  constructor(
    private readonly reads: AuthorizedWorkspaceReads,
    private readonly availability: ListingCreationAvailabilityProjection,
  ) {}

  run(actor: ProviderActor): Promise<CurrentWorkspaceDto> {
    return this.reads.query(
      actor.authority,
      {
        workspaceId: actor.workspaceId,
        action: 'workspace.presentation.read',
        resourceIds: [],
        purpose: 'OPERATIONAL',
      },
      () => Promise.resolve(),
      async (context, tx) => {
        const workspace = await tx.providerWorkspace.findUniqueOrThrow({
          where: { id: context.workspaceId },
          select: { id: true, displayName: true, kind: true },
        });
        const member = await tx.workspaceMembership.findUniqueOrThrow({
          where: { id: context.membershipId, workspaceId: context.workspaceId },
          select: { displayColor: true },
        });
        if (!isMemberColor(member.displayColor))
          throw new Error('Invalid persisted member color');
        return {
          workspace,
          membership: {
            id: context.membershipId,
            role: context.role,
            colorId: member.displayColor,
          },
          actions: {
            createListing: await this.availability.project(tx, context),
          },
        };
      },
    );
  }
}
