import { Injectable, NotFoundException } from '@nestjs/common';

import { ListingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublishedListingsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPublishedListingOrThrow(
    listingId: string,
  ): Promise<{ id: string; status: ListingStatus; publishedAt: Date }> {
    const listing = await this.prisma.publicListingProjection.findFirst({
      where: {
        id: listingId,
      },
      select: { id: true, publishedAt: true },
    });

    if (!listing?.publishedAt) {
      throw new NotFoundException('Listing not found');
    }

    return {
      id: listing.id,
      status: ListingStatus.PUBLISHED,
      publishedAt: listing.publishedAt,
    };
  }
}
