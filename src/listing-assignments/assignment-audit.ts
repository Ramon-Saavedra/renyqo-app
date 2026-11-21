import type {
  Prisma,
  ListingTransferRequest,
} from '../generated/prisma/client';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
import { appendDomainEvidence } from '../audit/context/domain-audit';

export async function assignmentAudit(
  tx: Prisma.TransactionClient,
  actor: AuthorizationContext,
  commandId: string,
  correlationId?: string,
) {
  const row = await tx.listingAssignmentTransition.findUniqueOrThrow({
    where: {
      workspaceId_commandId: { workspaceId: actor.workspaceId, commandId },
    },
  });
  return appendDomainEvidence(
    tx,
    actor,
    commandId,
    'provider.assignment',
    `listing_assignment.changed:${row.listingId}`,
    { kind: 'ASSIGNMENT', id: row.id },
    correlationId,
  );
}
export function transferAudit(
  tx: Prisma.TransactionClient,
  actor: AuthorizationContext,
  row: ListingTransferRequest,
) {
  const action =
    row.status === 'REQUESTED'
      ? 'requested'
      : row.status === 'EXPIRED'
        ? 'expired'
        : 'decided';
  return appendDomainEvidence(
    tx,
    actor,
    row.commandId,
    'provider.transfer',
    `listing_transfer.${action}:${row.id}`,
    { kind: 'TRANSFER_REQUEST', id: row.id },
    row.correlationId ?? undefined,
  );
}
