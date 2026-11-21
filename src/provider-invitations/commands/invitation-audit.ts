import type {
  Prisma,
  WorkspaceInvitation,
} from '../../generated/prisma/client';
import type {
  AuthorizationContext,
  SessionAuthority,
} from '../../provider-authorization/domain/authorization.types';
import { appendDomainEvidence } from '../../audit/context/domain-audit';
import { withRequiredAudit } from '../../audit/context/required-audit';
import { AuditSignals } from '../../audit/observability/audit-signals';
import { auditFailure } from '../../audit/observability/audit-failure';

export function invitationAudit(
  tx: Prisma.TransactionClient,
  actor: AuthorizationContext,
  row: WorkspaceInvitation,
  commandId: string,
  kind: 'CREATE' | 'RESEND' | 'REVOKE' | 'EXPIRE',
) {
  const action =
    kind === 'CREATE'
      ? 'created'
      : kind === 'RESEND'
        ? 'resent'
        : row.status === 'EXPIRED'
          ? 'expired'
          : 'revoked';
  return appendDomainEvidence(
    tx,
    actor,
    commandId,
    'provider.invitation',
    `invitation.${action}:${row.id}`,
    { kind: 'INVITATION_COMMAND', id: commandId },
  );
}

// Separate USER admission boundary. Membership does not establish the actor.
export async function invitationAdmissionAudit(
  tx: Prisma.TransactionClient,
  actor: SessionAuthority,
  invitationId: string,
  membershipId: string,
  commandId: string,
  created: boolean,
) {
  const signals = new AuditSignals();
  const effects = [
    `invitation.accepted:${invitationId}`,
    ...(created ? [`membership.created:${membershipId}`] : []),
  ];
  try {
    const command = {
      commandId,
      commandScope: 'provider.invitation.accept',
      correlationId: commandId,
      requiredEffects: effects,
    };
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT open_invitation_audit_execution(${invitationId}::uuid,
      ${actor.userId}::uuid,${actor.authVersion},${actor.sessionId},${JSON.stringify(command)}::jsonb) AS id`;
    await withRequiredAudit(tx, row.id, signals, async (audit) => {
      await audit.append({
        effectKey: effects[0],
        evidence: { kind: 'INVITATION_COMMAND', id: commandId },
      });
      if (created)
        await audit.append({
          effectKey: effects[1],
          evidence: { kind: 'MEMBERSHIP_ADMISSION', id: commandId },
        });
    });
  } catch (error) {
    signals.report('AUDIT_APPEND_FAILED');
    throw auditFailure('Required admission audit failed', error);
  }
}
