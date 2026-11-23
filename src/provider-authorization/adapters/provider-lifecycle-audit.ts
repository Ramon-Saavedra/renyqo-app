import type { Prisma } from '../../generated/prisma/client';
import type { AuthorizationContext } from '../domain/authorization.types';
import type { ProviderOperation } from '../operations/provider-operation';
import { projectProviderResult } from '../projections/provider-result-projection';
import { withListingLifecycleAudit } from '../../listings/listing-audit-boundary';
import { withApplicationLifecycleAudit } from '../../applications/application-audit-boundary';
import { auditsApplicationLifecycle } from '../../applications/application-audit-operations';

// Adapt an already authorized/locked callback; no new policy or tenant selector.
export async function projectAuditedProviderMutation<T>(
  tx: Prisma.TransactionClient,
  context: AuthorizationContext,
  operation: ProviderOperation,
  commandId: string,
  listingId: string | undefined,
  work: () => Promise<T>,
  applicationId?: string,
  applicationConsequences = false,
) {
  const actor = { kind: 'MEMBER' as const, context };
  const listingWork =
    listingId && operation === 'listing.write'
      ? () => withListingLifecycleAudit(tx, actor, commandId, listingId, work)
      : work;
  // Rental closing and publication/resume explicitly opt into both domains.
  // Media, assignment, documents and conversations do not scan Applications.
  const result =
    listingId &&
    (applicationConsequences || auditsApplicationLifecycle(operation))
      ? await withApplicationLifecycleAudit(
          tx,
          actor,
          commandId,
          [listingId],
          listingWork,
          applicationId,
        )
      : await listingWork();
  return projectProviderResult(result, context, operation);
}
