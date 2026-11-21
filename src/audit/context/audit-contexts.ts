import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import type {
  AuthorizationContext,
  SessionAuthority,
  SystemAuthority,
  SystemAuthorityPolicy,
} from '../../provider-authorization/domain/authorization.types';
import { auditCommand, type AuditCommand } from '../commands/audit-command';
import { AuditSignals } from '../observability/audit-signals';
import { auditFailure } from '../observability/audit-failure';
import { withRequiredAudit, type RequiredAudit } from './required-audit';

@Injectable()
export class AuditContexts {
  constructor(private readonly signals: AuditSignals) {}
  // Invoke ONLY inside the existing ProtectedWorkspaceTransactions callback,
  // after domain receipt replay. Context is produced by that coordinator.
  async member<T>(
    tx: Prisma.TransactionClient,
    actor: AuthorizationContext,
    command: AuditCommand,
    work: (audit: RequiredAudit) => Promise<T>,
  ) {
    if (!actor || actor.status !== 'ACTIVE' || !actor.membershipId) {
      this.signals.report('AUDIT_CONTEXT_MISSING');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw new Error('Required audit context missing');
    }
    return this.human(
      tx,
      actor.workspaceId,
      actor.userId,
      actor.authVersion,
      actor.mode,
      actor.sessionId ?? null,
      actor.membershipId,
      actor.membershipRevision,
      null,
      command,
      work,
    );
  }
  // ApplicantListingAccess has already resolved this owned application and
  // installed its tenant. SQL independently checks that same relationship.
  async user<T>(
    tx: Prisma.TransactionClient,
    actor: SessionAuthority,
    applicationId: string,
    command: AuditCommand,
    work: (audit: RequiredAudit) => Promise<T>,
  ) {
    if (!actor || actor.mode !== 'SESSION_BOUND') {
      this.signals.report('AUDIT_CONTEXT_MISSING');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw new Error('Required audit context missing');
    }
    return this.human(
      tx,
      null,
      actor.userId,
      actor.authVersion,
      actor.mode,
      actor.sessionId,
      null,
      null,
      applicationId,
      command,
      work,
    );
  }
  private async human<T>(
    tx: Prisma.TransactionClient,
    workspace: string | null,
    user: string,
    version: number,
    mode: string,
    sid: string | null,
    member: string | null,
    revision: number | null,
    application: string | null,
    input: AuditCommand,
    work: (audit: RequiredAudit) => Promise<T>,
  ) {
    let command: AuditCommand;
    try {
      command = auditCommand(input);
    } catch (error) {
      this.signals.report('AUDIT_PAYLOAD_REJECTED');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw error;
    }
    let id: string;
    try {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT open_human_audit_execution(${workspace}::uuid,${user}::uuid,${version},${mode},${sid},
          ${member}::uuid,${revision}::integer,${application}::uuid,${JSON.stringify(command)}::jsonb) AS id`;
      id = row.id;
    } catch (error) {
      this.signals.report('AUDIT_ACTOR_INVALID');
      throw auditFailure('Invalid audit actor attribution', error);
    }
    return withRequiredAudit(tx, id, this.signals, work);
  }
  async system<T>(
    tx: Prisma.TransactionClient,
    authority: SystemAuthority,
    policy: SystemAuthorityPolicy,
    command: AuditCommand,
    work: (audit: RequiredAudit) => Promise<T>,
  ) {
    if (
      !authority ||
      !policy ||
      !authority.scope ||
      authority.mode !== 'SYSTEM' ||
      authority.purpose !== 'AUDIT_LEDGER_ACTIVATION' ||
      policy.purpose !== authority.purpose ||
      authority.scope.action !== 'audit.ledger.activated' ||
      authority.scope.resourceIds.length !== 1 ||
      authority.scope.resourceIds[0] !== authority.workspaceId
    ) {
      this.signals.report('AUDIT_ACTOR_INVALID');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw new Error('Invalid audit system purpose');
    }
    try {
      await policy.authorize(tx, authority);
    } catch {
      this.signals.report('AUDIT_ACTOR_INVALID');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw new Error('Invalid audit system policy');
    }
    let bound: AuditCommand;
    try {
      bound = auditCommand(command);
    } catch (error) {
      this.signals.report('AUDIT_PAYLOAD_REJECTED');
      await tx.$executeRaw`SELECT reject_required_audit()`;
      throw error;
    }
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT open_system_audit_execution(${authority.workspaceId}::uuid,${authority.purpose},
        ${JSON.stringify(bound)}::jsonb) AS id`;
    // This private DB function is NOT granted to the human application runtime.
    return withRequiredAudit(tx, row.id, this.signals, work);
  }
}
