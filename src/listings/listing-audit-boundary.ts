import type { Prisma } from '../generated/prisma/client';
import type { LifecycleActor } from '../audit/domain/lifecycle-action';
import { auditedWork } from '../audit/context/audited-work';
import { listingLifecycleAudit } from './listing-lifecycle-audit';

// Listing-only evidence. Never scans Applications or owns their transitions.
export function withListingLifecycleAudit<T>(
  tx: Prisma.TransactionClient,
  actor: Extract<LifecycleActor, { kind: 'MEMBER' }>,
  commandId: string,
  listingId: string,
  work: () => Promise<T>,
  ordering = false,
) {
  return auditedWork(tx, async () => {
    const before = await tx.listing.findUniqueOrThrow({
      where: { id: listingId, workspaceId: actor.context.workspaceId },
    });
    const result = await work();
    const after = await tx.listing.findUniqueOrThrow({
      where: { id: listingId, workspaceId: before.workspaceId },
    });
    await listingLifecycleAudit(tx, actor, commandId, before, after, ordering);
    return result;
  });
}
