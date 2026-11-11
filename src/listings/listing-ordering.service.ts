import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ProviderListingAccess,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';

@Injectable()
export class ListingOrderingService {
  constructor(private readonly access: ProviderListingAccess) {}

  async getNextDisplayOrder(tx: Prisma.TransactionClient, workspaceId: string) {
    const [row] = await tx.$queryRaw<{ next: number }[]>`
      SELECT COALESCE(max(display_order),0)+1 AS next FROM listings WHERE workspace_id=${workspaceId}::uuid AND status<>'retired'`;
    return row.next;
  }

  async compactWithinTransaction(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    orderedIds?: string[],
  ) {
    await tx.$queryRaw`SELECT id FROM listings WHERE workspace_id=${workspaceId}::uuid AND status<>'retired' ORDER BY id FOR UPDATE`;
    const rows = await tx.listing.findMany({
      where: { workspaceId, status: { not: 'RETIRED' } },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, displayOrder: true },
    });
    const ids = orderedIds ?? rows.map((r) => r.id);
    if (
      ids.length !== rows.length ||
      new Set(ids).size !== rows.length ||
      ids.some((id) => !rows.some((r) => r.id === id))
    )
      throw new BadRequestException('Invalid workspace ordering');
    if (
      rows.every(
        (r, index) => r.id === ids[index] && r.displayOrder === index + 1,
      )
    )
      return;
    const temporary =
      Math.max(0, ...rows.map((r) => r.displayOrder ?? 0)) + rows.length;
    for (const [index, id] of ids.entries())
      await tx.listing.update({
        where: { id, workspaceId },
        data: { displayOrder: temporary + index + 1 },
      });
    for (const [index, id] of ids.entries())
      await tx.listing.update({
        where: { id, workspaceId },
        data: { displayOrder: index + 1 },
      });
  }

  move(listingId: string, actor: ProviderActor, position: number) {
    if (!Number.isInteger(position) || position < 1)
      throw new BadRequestException('position must be a positive integer');
    return this.access.mutate(
      actor,
      'listing.order',
      undefined,
      async (tx, context) => {
        if (context.role !== 'OWNER')
          throw new ForbiddenException('OWNER required for workspace ordering');
        await tx.$queryRaw`SELECT id FROM listings WHERE workspace_id=${context.workspaceId}::uuid AND status<>'retired' ORDER BY id FOR UPDATE`;
        const rows = await tx.listing.findMany({
          where: {
            workspaceId: context.workspaceId,
            status: { not: 'RETIRED' },
          },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        const ids = rows.map((r) => r.id);
        const from = ids.indexOf(listingId);
        if (from < 0) throw new NotFoundException('Listing not found');
        if (position > ids.length)
          throw new BadRequestException(
            'Position exceeds operational portfolio',
          );
        ids.splice(from, 1);
        ids.splice(position - 1, 0, listingId);
        await this.compactWithinTransaction(tx, context.workspaceId, ids);
        return tx.listing.findUniqueOrThrow({
          where: { id: listingId, workspaceId: context.workspaceId },
        });
      },
    );
  }
}
