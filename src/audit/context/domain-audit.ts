import type { Prisma } from '../../generated/prisma/client';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import { AuditContexts } from './audit-contexts';
import { AuditSignals } from '../observability/audit-signals';
import type {
  DomainAuditScope,
  DomainEvidence,
} from '../domain/domain-evidence';

// Transport-only adapter. The owning domain chooses real evidence and checks
// replay. SQL derives the payload from that evidence under the selected tenant.
export async function appendDomainEvidence(
  tx: Prisma.TransactionClient,
  actor: AuthorizationContext,
  commandId: string,
  scope: DomainAuditScope,
  effectKey: string,
  evidence: DomainEvidence,
  correlationId = commandId,
) {
  return new AuditContexts(new AuditSignals()).member(
    tx,
    actor,
    {
      commandId,
      commandScope: scope,
      correlationId,
      requiredEffects: [effectKey],
    },
    (audit) => audit.append({ effectKey, evidence }),
  );
}
