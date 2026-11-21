import type { Prisma } from '../../generated/prisma/client';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import { appendDomainEvidence } from '../../audit/context/domain-audit';

export async function planAudit(
  tx: Prisma.TransactionClient,
  actor: AuthorizationContext,
  commandId: string,
) {
  const row = await tx.workspacePlanChange.findUniqueOrThrow({
    where: {
      workspaceId_commandId: { workspaceId: actor.workspaceId, commandId },
    },
  });
  return appendDomainEvidence(
    tx,
    actor,
    commandId,
    'provider.plan',
    `plan.assigned:${actor.workspaceId}`,
    { kind: 'PLAN_CHANGE', id: row.id },
  );
}
