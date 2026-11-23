import type { Prisma } from '../generated/prisma/client';
export async function applicationAuditState(
  tx: Prisma.TransactionClient,
  listingIds: readonly string[],
  applicationId?: string,
  priorIds: readonly string[] = [],
) {
  if (!listingIds.length) return [];
  return tx.application.findMany({
    where: {
      listingId: { in: [...listingIds] },
      OR: [
        { status: { in: ['ACTIVE', 'WAITING'] } },
        ...(applicationId ? [{ id: applicationId }] : []),
        ...(priorIds.length ? [{ id: { in: [...priorIds] } }] : []),
      ],
    },
    select: { id: true, status: true },
  });
}
export type ApplicationAuditState = Awaited<
  ReturnType<typeof applicationAuditState>
>;
