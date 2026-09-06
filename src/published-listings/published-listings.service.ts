import { Injectable, NotFoundException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { ListingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublishedListingsService {
  constructor(private readonly prisma: PrismaService) {}

  getPublicAccessWhere(): Prisma.ListingWhereInput {
    return {
      status: ListingStatus.PUBLISHED,
      publishedAt: { not: null },
    };
  }

  getPublicAccessWhereFragments(): readonly Prisma.ListingWhereInput[] {
    return [
      { status: ListingStatus.PUBLISHED },
      { publishedAt: { not: null } },
    ];
  }

  async findPublishedListingOrThrow(
    listingId: string,
  ): Promise<{ id: string; status: ListingStatus; publishedAt: Date }> {
    const listing = await this.prisma.listing.findFirst({
      where: {
        id: listingId,
        ...this.getPublicAccessWhere(),
      },
      select: { id: true, status: true, publishedAt: true },
    });

    if (!listing?.publishedAt) {
      throw new NotFoundException('Listing not found');
    }

    return {
      id: listing.id,
      status: listing.status,
      publishedAt: listing.publishedAt,
    };
  }
}
