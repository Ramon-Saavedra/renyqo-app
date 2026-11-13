import type { Prisma } from '../../generated/prisma/client';

// Caller must already own an authorized scoped read/write transaction. A global
// User ID is actor attribution, never Listing ownership or a bootstrap credential.
export async function hasListingParticipation(
  tx: Prisma.TransactionClient,
  userId: string,
  listing: {
    workspaceId: string;
    responsibleMembershipId: string;
    status: string;
  },
) {
  const [row] = await tx.$queryRaw<{ allowed: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=${listing.workspaceId}::uuid AND m.workspace_id=current_workspace_id()
      AND m.user_id=${userId}::uuid AND m.status='ACTIVE' AND u.status='active'
      AND (${listing.status}::text<>'RETIRED' OR m.role='OWNER')
      AND (m.role='OWNER' OR m.id=${listing.responsibleMembershipId}::uuid)) AS allowed`;
  return row?.allowed === true;
}
