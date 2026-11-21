import { invitationAudit } from '../commands/invitation-audit';
import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  WorkspaceInvitation,
} from '../../generated/prisma/client';
import type { AuthorizationContext } from '../../provider-authorization/domain/authorization.types';
import { SeatReservations } from '../../provider-entitlements/capacity/seat-reservations';
import { SecurityLinkPolicy } from '../../security/security-link-policy';
import { commandFingerprint } from '../../security/opaque-secret';
import { InvitationRepository } from '../persistence/invitation.repository';
import { invitationConflict, invitationRateLimited } from './invitation-errors';
import type { MemberColor } from '../../member-presentation/member-color.catalog';

@Injectable()
export class InvitationLifecycle {
  constructor(
    private readonly reservations: SeatReservations,
    private readonly repository: InvitationRepository,
    private readonly policy: SecurityLinkPolicy,
  ) {}
  async create(
    tx: Prisma.TransactionClient,
    ctx: AuthorizationContext,
    input: {
      id: string;
      reservationId: string;
      expiryCommandId: string;
      commandId: string;
      email: string;
      hash: string;
      ownershipRevision: number;
      requestedColorId?: MemberColor;
    },
  ) {
    const pending = await tx.workspaceInvitation.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        email: input.email,
        status: 'PENDING',
      },
    });
    if (pending) {
      if (pending.expiresAt > (await this.repository.clock(tx)))
        invitationConflict('INVITATION_ALREADY_PENDING');
      const expired = await this.terminate(tx, pending, 'EXPIRED');
      await this.repository.record(
        tx,
        {
          workspaceId: ctx.workspaceId,
          commandId: input.expiryCommandId,
          actorUserId: ctx.userId,
          kind: 'EXPIRE',
          inputHash: commandFingerprint(['EXPIRE', pending.id]),
        },
        expired.id,
        expired.revision,
      );
      await invitationAudit(tx, ctx, expired, input.expiryCommandId, 'EXPIRE');
    }
    const member = await tx.workspaceMembership.findFirst({
      where: { workspaceId: ctx.workspaceId, user: { email: input.email } },
    });
    if (member)
      invitationConflict(
        member.status === 'ACTIVE'
          ? 'MEMBERSHIP_ALREADY_EXISTS'
          : 'MEMBERSHIP_LIFECYCLE_CONFLICT',
      );
    const workspace = await tx.providerWorkspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
    });
    if (workspace.kind !== 'ORGANIZATION')
      invitationConflict('ORGANIZATION_REQUIRED');
    const now = await this.repository.clock(tx),
      expiresAt = new Date(now.getTime() + this.policy.invitationTtl * 1000);
    await this.reservations.reserve(tx, {
      id: input.reservationId,
      workspaceId: ctx.workspaceId,
      commandId: input.commandId,
      expiresAt,
    });
    return tx.workspaceInvitation.create({
      data: {
        id: input.id,
        workspaceId: ctx.workspaceId,
        email: input.email,
        createdByMembershipId: ctx.membershipId,
        reservationId: input.reservationId,
        tokenHash: input.hash,
        expiresAt,
        issuerMembershipRevision: ctx.membershipRevision,
        issuerAuthVersion: ctx.authVersion,
        ownershipRevision: input.ownershipRevision,
        requestedColorId: input.requestedColorId,
      },
    });
  }
  async resend(
    tx: Prisma.TransactionClient,
    ctx: AuthorizationContext,
    row: WorkspaceInvitation,
    hash: string,
    revision: number,
    ownershipRevision: number,
  ) {
    if (row.revision !== revision)
      invitationConflict('INVITATION_REVISION_CONFLICT');
    const now = await this.repository.clock(tx);
    if (
      row.status !== 'PENDING' ||
      row.expiresAt <= now ||
      row.createdByMembershipId !== ctx.membershipId
    )
      invitationConflict('INVITATION_UNAVAILABLE');
    if (
      row.issuedAt.getTime() + this.policy.resendCooldown * 1000 >
      now.getTime()
    )
      invitationRateLimited();
    // Reservation-before-invitation lock order, even though the root serializes writers.
    await tx.$queryRaw`SELECT id FROM workspace_seat_reservations WHERE id=${row.reservationId}::uuid FOR UPDATE`;
    return tx.workspaceInvitation.update({
      where: { id: row.id },
      data: {
        tokenHash: hash,
        issuerMembershipRevision: ctx.membershipRevision,
        issuerAuthVersion: ctx.authVersion,
        ownershipRevision,
      },
    });
  }
  async terminate(
    tx: Prisma.TransactionClient,
    row: WorkspaceInvitation,
    status: 'REVOKED' | 'EXPIRED',
  ) {
    if (row.status !== 'PENDING') return row;
    await this.reservations.release(tx, row.workspaceId, row.reservationId);
    return tx.workspaceInvitation.update({
      where: { id: row.id },
      data: { status },
    });
  }
}
