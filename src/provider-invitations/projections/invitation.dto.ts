import type { WorkspaceInvitation } from '../../generated/prisma/client';
export function invitationDto(
  row: WorkspaceInvitation,
  now: Date,
  ownerMembershipId: string,
  cooldown: number,
) {
  const status =
    row.status === 'PENDING' && row.expiresAt <= now ? 'EXPIRED' : row.status;
  return {
    id: row.id,
    email: row.email,
    requestedColorId: row.requestedColorId,
    status,
    expiresAt: row.expiresAt,
    revision: row.revision,
    createdAt: row.createdAt,
    issuedAt: row.issuedAt,
    delivery: row.deliveryStatus,
    actions: {
      canRevoke: status === 'PENDING',
      canResend:
        status === 'PENDING' &&
        row.createdByMembershipId === ownerMembershipId &&
        row.issuedAt.getTime() + cooldown * 1000 <= now.getTime(),
    },
  };
}
