import type { Prisma } from '../../generated/prisma/client';
import type {
  LifecycleActor,
  LifecycleAuditEffect,
} from '../domain/lifecycle-action';
import { AuditContexts } from './audit-contexts';
import { AuditSignals } from '../observability/audit-signals';
import { withRequiredAudit } from './required-audit';
import { auditFailure } from '../observability/audit-failure';
import { auditCommand } from '../commands/audit-command';

export async function appendLifecycleEffect(
  tx: Prisma.TransactionClient,
  actor: LifecycleActor,
  commandId: string,
  effect: LifecycleAuditEffect,
  applicationId?: string,
) {
  const command = auditCommand({
    commandId,
    commandScope:
      effect.transition.kind === 'LISTING_STATE'
        ? 'provider.lifecycle'
        : 'application.lifecycle',
    correlationId: commandId,
    requiredEffects: [effect.effectKey],
  });
  const signals = new AuditSignals(),
    contexts = new AuditContexts(signals);
  if (actor.kind === 'MEMBER')
    return contexts.member(tx, actor.context, command, (audit) =>
      audit.append(effect),
    );
  if (actor.kind === 'USER') {
    if (!applicationId) {
      signals.report('AUDIT_CONTEXT_MISSING');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw new Error('Missing application audit scope');
    }
    return contexts.user(tx, actor.authority, applicationId, command, (audit) =>
      audit.append(effect),
    );
  }
  if (effect.transition.kind !== 'APPLICATION_ACTIVITY') {
    await tx.$executeRaw`SELECT reject_required_audit()`;
    throw new Error('Invalid system effect');
  }
  try {
    const bound = { ...command, commandScope: 'application.lifecycle.system' };
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT open_system_lifecycle_audit(${effect.transition.activityId}::uuid,
   ${JSON.stringify(bound)}::jsonb,${actor.profileScopeId ?? null}::uuid) AS id`;
    return await withRequiredAudit(tx, row.id, signals, (audit) =>
      audit.append(effect),
    );
  } catch (error) {
    signals.report('AUDIT_APPEND_FAILED');
    throw auditFailure('Required lifecycle audit failed', error);
  }
}
