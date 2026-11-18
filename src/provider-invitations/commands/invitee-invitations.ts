import { Injectable } from '@nestjs/common';
import type { SessionAuthority } from '../../provider-authorization/domain/authorization.types';
import { ProtectedWorkspaceTransactions } from '../../provider-authorization/protected-workspace-transactions';
import { GlobalAuthorityReader } from '../../provider-authorization/persistence/global-authority.reader';
import { invitationRoute } from '../../provider-authorization/invitation-acceptance.transaction';
import { installTenantContext } from '../../provider-tenancy/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { hashSecret } from '../../security/opaque-secret';
import {
  invitationMissing,
  translateInvitationFailure,
} from '../domain/invitation-errors';
@Injectable()
export class InviteeInvitations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly global: GlobalAuthorityReader,
  ) {}
  async inspect(a: SessionAuthority, secret: string) {
    const hash = hashSecret('workspace-invitation', secret);
    return this.prisma.$transaction(async (tx) => {
      await this.global.assert(tx, a);
      const route = await invitationRoute(tx, a, hash);
      await installTenantContext(tx, route.workspace_id);
      const [row] = await tx.$queryRaw<
        { id: string; expiresAt: Date; displayName: string; status: string }[]
      >`
        SELECT i.id,i.expires_at AS "expiresAt",w.display_name AS "displayName",i.status::text FROM workspace_invitations i
        JOIN provider_workspaces w ON w.id=i.workspace_id JOIN workspace_memberships m ON m.id=i.created_by_membership_id
        JOIN users u ON u.id=m.user_id WHERE i.id=${route.invitation_id}::uuid AND w.lifecycle_status='ACTIVE'
        AND ((i.status='PENDING' AND i.expires_at>clock_timestamp() AND m.role='OWNER' AND m.status='ACTIVE' AND m.revision=i.issuer_membership_revision
          AND u.status='active' AND u.auth_version=i.issuer_auth_version AND w.ownership_revision=i.ownership_revision)
          OR i.status='ACCEPTED')`;
      if (!row) invitationMissing();
      return {
        id: row.id,
        workspaceName: row.displayName,
        role: 'AGENT',
        status: row.status,
        expiresAt: row.expiresAt,
      };
    });
  }
  async accept(a: SessionAuthority, secret: string, commandId: string) {
    try {
      return await this.writes.acceptInvitation(
        a,
        hashSecret('workspace-invitation', secret),
        commandId,
      );
    } catch (error) {
      translateInvitationFailure(error);
    }
  }
}
