import type { Prisma } from '../generated/prisma/client';
import type { LifecycleActor } from '../audit/domain/lifecycle-action';
import { auditedWork } from '../audit/context/audited-work';
import { applicationAuditState } from './application-audit-state';
import { applicationLifecycleAudit } from './application-lifecycle-audit';

// Join an already authorized, listing-locked transaction. Only Application
// lifecycle commands and their explicit listing/workflow consequences enter here.
export function withApplicationLifecycleAudit<T>(
  tx: Prisma.TransactionClient,
  actor: LifecycleActor,
  commandId: string,
  listingIds: readonly string[],
  work: () => Promise<T>,
  applicationId?: string,
) {
  return auditedWork(tx, async () => {
    const before = await applicationAuditState(tx, listingIds, applicationId);
    const result = await work();
    await applicationLifecycleAudit(
      tx,
      actor,
      commandId,
      listingIds,
      before,
      applicationId,
    );
    return result;
  });
}
