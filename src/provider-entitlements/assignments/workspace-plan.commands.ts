import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { capacityConflict } from '../capacity/capacity.policy';

export interface PlanChange {
  workspaceId: string;
  actorMembershipId: string;
  expectedRevision: number;
  planVersionId: string | null;
  commandId: string;
  mode: 'VOLUNTARY' | 'FORCED';
  source: 'INTERNAL' | 'MOCK_DEV';
}
// Internal caller-owned protected transaction only. No generic admin endpoint.
@Injectable()
export class WorkspacePlanCommands {
  async assign(tx: Prisma.TransactionClient, input: PlanChange) {
    const prior = await tx.workspacePlanChange.findUnique({
      where: {
        workspaceId_commandId: {
          workspaceId: input.workspaceId,
          commandId: input.commandId,
        },
      },
    });
    if (prior) {
      if (
        prior.planVersionId !== input.planVersionId ||
        prior.actorMembershipId !== input.actorMembershipId ||
        prior.changeMode !== input.mode ||
        prior.source !== input.source
      )
        capacityConflict('PLAN_REVISION_CONFLICT');
      return tx.workspacePlanAssignment.findUniqueOrThrow({
        where: { workspaceId: input.workspaceId },
      });
    }
    const result = await tx.workspacePlanAssignment.updateMany({
      where: {
        workspaceId: input.workspaceId,
        revision: input.expectedRevision,
      },
      data: {
        planVersionId: input.planVersionId,
        commandId: input.commandId,
        actorMembershipId: input.actorMembershipId,
        changeMode: input.mode,
        source: input.source,
      },
    });
    if (result.count !== 1) capacityConflict('PLAN_REVISION_CONFLICT');
    return tx.workspacePlanAssignment.findUniqueOrThrow({
      where: { workspaceId: input.workspaceId },
    });
  }
}
