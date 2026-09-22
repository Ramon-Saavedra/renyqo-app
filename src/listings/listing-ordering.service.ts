import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Listing, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';

type TransactionClient = Prisma.TransactionClient;

@Injectable()
export class ListingOrderingService {
  constructor(private readonly prisma: PrismaService) {}

  async getNextDisplayOrder(
    tx: TransactionClient,
    providerId: string,
  ): Promise<number> {
    await this.lockProvider(tx, providerId);

    const result = await tx.listing.aggregate({
      where: { providerId },
      _max: { displayOrder: true },
    });

    return (result._max.displayOrder ?? 0) + 1;
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

      const listing = await tx.listing.findFirst({
        where: { id: listingId, providerId },
        select: { id: true, displayOrder: true },
      });

      if (!listing) {
        throw new NotFoundException('Listing not found');
      }

      const providerListingCount = await tx.listing.count({
        where: { providerId },
      });

      if (requestedPosition > providerListingCount) {
        throw new BadRequestException(
          `position must be between 1 and ${providerListingCount}`,
        );
      }

      if (requestedPosition === listing.displayOrder) {
        const currentListing = await tx.listing.findUnique({
          where: { id: listingId },
        });

        if (!currentListing) {
          throw new NotFoundException('Listing not found');
        }

        return currentListing;
      }

      await tx.listing.update({
        where: { id: listingId },
        data: { displayOrder: 0 },
      });

      const temporaryOffset = providerListingCount + 1;

      if (requestedPosition < listing.displayOrder) {
        await tx.listing.updateMany({
          where: {
            providerId,
            displayOrder: {
              gte: requestedPosition,
              lt: listing.displayOrder,
            },
          },
          data: { displayOrder: { increment: temporaryOffset } },
        });
        await tx.listing.updateMany({
          where: {
            providerId,
            displayOrder: {
              gt: temporaryOffset,
              lte: temporaryOffset + listing.displayOrder - requestedPosition,
            },
          },
          data: { displayOrder: { decrement: temporaryOffset - 1 } },
        });
      } else {
        await tx.listing.updateMany({
          where: {
            providerId,
            displayOrder: {
              gt: listing.displayOrder,
              lte: requestedPosition,
            },
          },
          data: { displayOrder: { decrement: temporaryOffset } },
        });
        await tx.listing.updateMany({
          where: {
            providerId,
            displayOrder: {
              gte: listing.displayOrder + 1 - temporaryOffset,
              lte: requestedPosition - temporaryOffset,
            },
          },
          data: { displayOrder: { increment: temporaryOffset - 1 } },
        });
      }

      return tx.listing.update({
        where: { id: listingId },
        data: { displayOrder: requestedPosition },
      });
    });
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
