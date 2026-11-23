import { randomUUID } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import type { SessionAuthority } from '../provider-authorization/domain/authorization.types';
import { withApplicationLifecycleAudit } from '../applications/application-audit-boundary';
import { AuditSignals } from '../audit/observability/audit-signals';
import { auditFailure } from '../audit/observability/audit-failure';

// Called inside the existing profile transaction, with its exact locked set.
// No tenant GUC is installed, switched, or borrowed from the current user.
export async function withProfileRevalidationAudit<T>(
  tx: Prisma.TransactionClient,
  actor: SessionAuthority,
  listingIds: readonly string[],
  work: () => Promise<T>,
  commandId = randomUUID(),
) {
  const signals = new AuditSignals();
  let scopeId: string;
  try {
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT open_profile_audit_scope(${actor.userId}::uuid,${actor.authVersion},${actor.sessionId}) AS id`;
    scopeId = row.id;
  } catch (error) {
    signals.report('AUDIT_ACTOR_INVALID');
    throw auditFailure('Invalid profile audit scope', error);
  }
  // Domain exceptions preserve their original HTTP/error semantics.
  const result = await withApplicationLifecycleAudit(
    tx,
    { kind: 'SYSTEM', profileScopeId: scopeId },
    commandId,
    listingIds,
    work,
  );
  try {
    await tx.$executeRaw`SELECT close_profile_audit_scope(${scopeId}::uuid)`;
  } catch (error) {
    signals.report('AUDIT_APPEND_FAILED');
    throw auditFailure('Required profile audit completion failed', error);
  }
  return result;
}
