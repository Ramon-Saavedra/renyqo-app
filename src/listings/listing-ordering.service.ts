import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Listing, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';

type TransactionClient = Prisma.TransactionClient;

type OrderedListing = {
  id: string;
  displayOrder: number;
};

@Injectable()
export class ListingOrderingService {
  constructor(private readonly prisma: PrismaService) {}

  async getNextDisplayOrder(
    tx: TransactionClient,
    providerId: string,
  ): Promise<number> {
    await this.lockProvider(tx, providerId);

    const listings = await this.loadProviderListings(tx, providerId);
    const orderedIds = listings.map((listing) => listing.id);

    if (!this.matchesContiguousOrder(listings, orderedIds)) {
      await this.persistVisibleOrder(
        tx,
        orderedIds,
        listings.map((listing) => listing.displayOrder),
      );
    }

    return listings.length + 1;
  }

  async move(
    listingId: string,
    providerId: string,
    requestedPosition: number,
  ): Promise<Listing> {
    if (!Number.isInteger(requestedPosition) || requestedPosition < 1) {
      throw new BadRequestException('position must be a positive integer');
    }

    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.lockProvider(tx, providerId);

      const listings = await this.loadProviderListings(tx, providerId);
      const currentIndex = listings.findIndex(
        (listing) => listing.id === listingId,
      );

      if (currentIndex === -1) {
        throw new NotFoundException('Listing not found');
      }

      if (requestedPosition > listings.length) {
        throw new BadRequestException(
          `position must be between 1 and ${listings.length}`,
        );
      }

      const reordered = [...listings];
      const [moved] = reordered.splice(currentIndex, 1);
      reordered.splice(requestedPosition - 1, 0, moved);
      const orderedIds = reordered.map((listing) => listing.id);

      if (!this.matchesContiguousOrder(listings, orderedIds)) {
        await this.persistVisibleOrder(
          tx,
          orderedIds,
          listings.map((listing) => listing.displayOrder),
        );
      }

      const movedListing = await tx.listing.findUnique({
        where: { id: listingId },
      });

      if (!movedListing) {
        throw new NotFoundException('Listing not found');
      }

      return movedListing;
    });
  }

  private async loadProviderListings(
    tx: TransactionClient,
    providerId: string,
  ): Promise<OrderedListing[]> {
    return tx.listing.findMany({
      where: { providerId },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, displayOrder: true },
    });
  }

  private matchesContiguousOrder(
    listings: readonly OrderedListing[],
    orderedIds: readonly string[],
  ): boolean {
    return (
      listings.length === orderedIds.length &&
      listings.every(
        (listing, index) =>
          listing.id === orderedIds[index] &&
          listing.displayOrder === index + 1,
      )
    );
  }

  private async persistVisibleOrder(
    tx: TransactionClient,
    orderedIds: readonly string[],
    currentDisplayOrders: readonly number[],
  ): Promise<void> {
    const highestDisplayOrder = currentDisplayOrders.reduce(
      (highest, displayOrder) => Math.max(highest, displayOrder),
      0,
    );
    const temporaryStart = highestDisplayOrder + orderedIds.length;

    for (const [index, listingId] of orderedIds.entries()) {
      await tx.listing.update({
        where: { id: listingId },
        data: { displayOrder: temporaryStart + index + 1 },
      });
    }

    for (const [index, listingId] of orderedIds.entries()) {
      await tx.listing.update({
        where: { id: listingId },
        data: { displayOrder: index + 1 },
      });
    }
  }

  private async lockProvider(
    tx: TransactionClient,
    providerId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM "users" WHERE id = ${providerId}::uuid FOR UPDATE
    `;
  }
}
