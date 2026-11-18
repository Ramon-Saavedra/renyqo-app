import { Injectable } from '@nestjs/common';
import type { WorkspaceInvitation } from '../../generated/prisma/client';
import { EmailService } from '../../email/email.service';
import { TenantTransactions } from '../../provider-tenancy/tenant-transactions';
import { SecurityLinkPolicy } from '../../security/security-link-policy';
@Injectable()
export class InvitationDelivery {
  constructor(
    private readonly email: EmailService,
    private readonly tenant: TenantTransactions,
    private readonly policy: SecurityLinkPolicy,
  ) {}
  assertConfigured() {
    this.email.assertSecurityDeliveryConfigured();
  }
  async send(row: WorkspaceInvitation, secret: string) {
    let outcome: 'ACCEPTED' | 'FAILED' = 'ACCEPTED';
    try {
      await this.email.sendSecurityLink({
        to: row.email,
        subject: 'Your Renyqo workspace invitation',
        text: 'Sign in with this email, verify it, and accept the workspace invitation.',
        label: 'Open invitation',
        url: this.policy.link('/workspace-invitation', secret),
      });
    } catch {
      outcome = 'FAILED';
    }
    try {
      await this.tenant.run(
        row.workspaceId,
        (tx) =>
          tx.$queryRaw`SELECT record_invitation_delivery(${row.workspaceId}::uuid,${row.id}::uuid,${row.generation},${outcome})`,
      );
    } catch {
      /* Unknown persisted outcome is truthful; never retry the same secret. */
    }
    return outcome;
  }
}
