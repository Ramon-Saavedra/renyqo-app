import { Injectable } from '@nestjs/common';
import { AuthorizedWorkspaceReads } from '../../provider-authorization/authorized-workspace-reads';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import {
  MEMBER_COLOR_IDS,
  isMemberColor,
  type MemberColor,
} from '../../member-presentation/member-color.catalog';
import { selectMemberColor } from '../../member-presentation/member-color.policy';
@Injectable()
export class MemberPaletteQuery {
  constructor(private readonly reads: AuthorizedWorkspaceReads) {}
  run(actor: ProviderActor) {
    return this.reads.query(
      actor.authority,
      {
        workspaceId: actor.workspaceId,
        action: 'team.palette.read',
        resourceIds: [],
        purpose: 'OPERATIONAL',
        requiredRole: 'OWNER',
      },
      () => Promise.resolve(),
      async (ctx, tx) => {
        const rows = await tx.workspaceMembership.groupBy({
          by: ['displayColor'],
          where: { workspaceId: ctx.workspaceId, status: { not: 'REMOVED' } },
          _count: true,
        });
        const usage = new Map<MemberColor, number>();
        for (const row of rows) {
          if (!isMemberColor(row.displayColor))
            throw new Error('Invalid persisted member color');
          usage.set(row.displayColor, row._count);
        }
        const recommended = selectMemberColor(usage);
        return {
          assignmentPolicy: 'UNUSED_THEN_LEAST_USED',
          canRecolor: false,
          colors: MEMBER_COLOR_IDS.map((id) => ({
            id,
            currentUsageCount: usage.get(id) ?? 0,
            currentlyUnused: !(usage.get(id) ?? 0),
            recommended: id === recommended,
          })),
        };
      },
    );
  }
}
