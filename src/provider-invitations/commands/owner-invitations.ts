import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceMembershipResolver } from '../../provider-authorization/workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from '../../provider-authorization/protected-workspace-transactions';
import type { ProviderActor } from '../../provider-authorization/provider-listing-access';
import { canonicalEmail } from '../../auth/identity/canonical-email';
import { issueSecret, commandFingerprint } from '../../security/opaque-secret';
import { SecurityLinkPolicy } from '../../security/security-link-policy';
import { InvitationRepository } from '../persistence/invitation.repository';
import { InvitationLifecycle } from '../domain/invitation-lifecycle';
import {
  invitationConflict,
  translateInvitationFailure,
} from '../domain/invitation-errors';
import { InvitationDelivery } from '../delivery/invitation-delivery';
import { invitationDto } from '../projections/invitation.dto';
export type OwnerInvitationInput =
  | { kind: 'CREATE'; email: string; commandId: string }
  | {
      kind: 'RESEND' | 'REVOKE';
      id: string;
      revision: number;
      commandId: string;
    };
@Injectable()
export class OwnerInvitations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: WorkspaceMembershipResolver,
    private readonly writes: ProtectedWorkspaceTransactions,
    private readonly repository: InvitationRepository,
    private readonly lifecycle: InvitationLifecycle,
    private readonly delivery: InvitationDelivery,
    private readonly policy: SecurityLinkPolicy,
  ) {}
  async run(actor: ProviderActor, input: OwnerInvitationInput) {
    const normalized =
      input.kind === 'CREATE'
        ? { ...input, email: canonicalEmail(input.email) }
        : input;
    const requirement = {
      workspaceId: actor.workspaceId,
      action: `invitation.${input.kind.toLowerCase()}`,
      resourceIds: [],
      purpose: 'OPERATIONAL' as const,
      requiredRole: 'OWNER' as const,
    };
    const ownership = await this.resolver.read(
      this.prisma,
      actor.authority,
      requirement,
      async (ctx, tx) => ({
        membershipId: ctx.membershipId,
        revision: (
          await tx.providerWorkspace.findUniqueOrThrow({
            where: { id: ctx.workspaceId },
          })
        ).ownershipRevision,
      }),
    );
    const token = issueSecret('workspace-invitation'),
      id = randomUUID(),
      reservationId = randomUUID(),
      expiryCommandId = randomUUID();
    try {
      const result = await this.writes.run(
        actor.authority,
        requirement,
        {
          kind: 'STRUCTURAL',
          expectedOwnershipRevision: ownership.revision,
          membershipIds: [],
        },
        () => Promise.resolve(),
        async (tx, ctx) => {
          const command = {
            workspaceId: ctx.workspaceId,
            commandId: input.commandId,
            kind: input.kind,
            actorUserId: ctx.userId,
            inputHash: commandFingerprint(normalized),
          };
          const replay = await this.repository.replay(tx, command);
          if (replay) return { row: replay, issued: false };
          let row;
          if (normalized.kind === 'CREATE') {
            this.delivery.assertConfigured();
            row = await this.lifecycle.create(tx, ctx, {
              ...normalized,
              id,
              reservationId,
              expiryCommandId,
              hash: token.hash,
              ownershipRevision: ownership.revision,
            });
          } else {
            const old = await this.repository.find(
              tx,
              ctx.workspaceId,
              normalized.id,
            );
            if (old.revision !== normalized.revision)
              invitationConflict('INVITATION_REVISION_CONFLICT');
            if (normalized.kind === 'RESEND') {
              this.delivery.assertConfigured();
              row = await this.lifecycle.resend(
                tx,
                ctx,
                old,
                token.hash,
                normalized.revision,
                ownership.revision,
              );
            } else {
              const now = await this.repository.clock(tx);
              row = await this.lifecycle.terminate(
                tx,
                old,
                old.expiresAt <= now ? 'EXPIRED' : 'REVOKED',
              );
            }
          }
          await this.repository.record(tx, command, row.id, row.revision);
          return { row, issued: normalized.kind !== 'REVOKE' };
        },
      );
      const delivery = result.issued
        ? await this.delivery.send(result.row, token.secret)
        : result.row.deliveryStatus;
      return {
        ...invitationDto(
          result.row,
          new Date(),
          ownership.membershipId,
          this.policy.resendCooldown,
        ),
        delivery,
      };
    } catch (error) {
      translateInvitationFailure(error);
    }
  }
}
