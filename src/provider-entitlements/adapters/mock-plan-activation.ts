import { auditedWork } from '../../audit/context/audited-work';
import { planAudit } from '../assignments/plan-audit';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import { ProtectedWorkspaceTransactions } from '../../provider-authorization/protected-workspace-transactions';
import { WorkspacePlanCommands } from '../assignments/workspace-plan.commands';
import { translateCapacityFailure } from './capacity-failure';
@Injectable()
export class MockPlanActivation {
  constructor(
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly plans: WorkspacePlanCommands,
  ) {}
  async activate(
    actor: ProviderActor,
    input: {
      planVersionId: string;
      expectedRevision: number;
      expectedOwnershipRevision: number;
      commandId: string;
    },
  ) {
    if (
      !['development', 'test'].includes(process.env['NODE_ENV'] ?? '') ||
      process.env['ENABLE_MOCK_PLAN_ACTIVATION'] !== 'true'
    )
      throw new NotFoundException();
    try {
      return await this.writes.run(
        actor.authority,
        {
          workspaceId: actor.workspaceId,
          action: 'plan.mock.activate',
          resourceIds: [],
          purpose: 'OPERATIONAL',
          requiredRole: 'OWNER',
        },
        {
          kind: 'STRUCTURAL',
          expectedOwnershipRevision: input.expectedOwnershipRevision,
          membershipIds: [],
        },
        async (_ctx, tx) => {
          const w = await tx.providerWorkspace.findUniqueOrThrow({
            where: { id: actor.workspaceId },
          });
          const p = await tx.planVersion.findUnique({
            where: { id: input.planVersionId },
          });
          if (w.kind !== 'ORGANIZATION' || p?.workspaceKind !== 'ORGANIZATION')
            throw new NotFoundException('Plan not available');
        },
        (tx, ctx) =>
          auditedWork(tx, async () => {
            const prior = await tx.workspacePlanChange.findUnique({
              where: {
                workspaceId_commandId: {
                  workspaceId: ctx.workspaceId,
                  commandId: input.commandId,
                },
              },
            });
            const result = await this.plans.assign(tx, {
              ...input,
              workspaceId: ctx.workspaceId,
              actorMembershipId: ctx.membershipId,
              source: 'MOCK_DEV',
              mode: 'VOLUNTARY',
            });
            if (!prior) await planAudit(tx, ctx, input.commandId);
            return result;
          }),
      );
    } catch (error) {
      translateCapacityFailure(error);
    }
  }
}
