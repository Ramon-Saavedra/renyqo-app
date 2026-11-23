import type { Prisma, Listing } from '../generated/prisma/client';
import {
  LISTING_AUDIT_FIELDS,
  type LifecycleActor,
} from '../audit/domain/lifecycle-action';
import { appendLifecycleEffect } from '../audit/context/lifecycle-append';

// Read values stay in this transaction. Only changed allowlisted field NAMES
// and lifecycle state/revisions are sent to Audit, never content/prices/criteria.
export async function listingLifecycleAudit(
  tx: Prisma.TransactionClient,
  actor: LifecycleActor,
  commandId: string,
  before: Listing | null,
  after: Listing,
  ordering = false,
) {
  const fields = before
    ? LISTING_AUDIT_FIELDS.filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      )
    : [];
  if (
    before &&
    before.status === after.status &&
    !fields.length &&
    (!ordering || before.displayOrder === after.displayOrder)
  )
    return;
  await appendLifecycleEffect(tx, actor, commandId, {
    effectKey: `listing.state:${after.id}`,
    transition: {
      kind: 'LISTING_STATE',
      listingId: after.id,
      previousStatus: before?.status ?? null,
      revisionBefore: before?.revision ?? null,
      changedFieldNames: fields,
      ordering,
      previousPosition: before?.displayOrder ?? null,
    },
  });
}
