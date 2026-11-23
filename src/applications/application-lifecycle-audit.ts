import type { Prisma } from '../generated/prisma/client';
import { type LifecycleActor } from '../audit/domain/lifecycle-action';
import { appendLifecycleEffect } from '../audit/context/lifecycle-append';
import {
  applicationAuditState,
  type ApplicationAuditState,
} from './application-audit-state';
import { AuditSignals } from '../audit/observability/audit-signals';

export async function applicationLifecycleAudit(
  tx: Prisma.TransactionClient,
  actor: LifecycleActor,
  commandId: string,
  listingIds: readonly string[],
  before: ApplicationAuditState,
  applicationId?: string,
) {
  if (!listingIds.length) return;
  const refs = await tx.$queryRaw<
    { id: string; applicationId: string; actorType: string }[]
  >`
    SELECT * FROM audit_application_effect_refs(${JSON.stringify(listingIds)}::jsonb,${actor.kind === 'SYSTEM' ? (actor.profileScopeId ?? null) : null}::uuid)`;
  const after = await applicationAuditState(
    tx,
    listingIds,
    applicationId,
    before.map((a) => a.id),
  );
  const prior = new Map(before.map((a) => [a.id, a.status])),
    covered = new Set(refs.map((r) => r.applicationId));
  if (
    after.some((a) => prior.get(a.id) !== a.status && !covered.has(a.id)) ||
    before.some((a) => !after.some((b) => b.id === a.id))
  ) {
    new AuditSignals().report('AUDIT_CONTEXT_MISSING');
    await tx.$executeRaw`SELECT reject_required_audit()`;
    throw new Error('Missing lifecycle evidence');
  }
  for (const ref of refs) {
    const bound: LifecycleActor =
      ref.actorType === 'SYSTEM'
        ? {
            kind: 'SYSTEM',
            ...(actor.kind === 'SYSTEM'
              ? { profileScopeId: actor.profileScopeId }
              : {}),
          }
        : actor;
    await appendLifecycleEffect(
      tx,
      bound,
      commandId,
      {
        effectKey: `application.activity:${ref.id}`,
        transition: { kind: 'APPLICATION_ACTIVITY', activityId: ref.id },
      },
      ref.applicationId,
    );
  }
}
