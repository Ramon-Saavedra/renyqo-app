import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ListingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { PublishedListingsService } from './published-listings.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000001';
const PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z');

type PrismaMock = {
  publicListingProjection: {
    findFirst: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
};

describe('PublishedListingsService', () => {
  let service: PublishedListingsService;
  let prismaMock: PrismaMock;

  beforeEach(async () => {
    prismaMock = {
      publicListingProjection: {
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishedListingsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get(PublishedListingsService);
  });

  it('returns a published listing', async () => {
    prismaMock.publicListingProjection.findFirst.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: PUBLISHED_AT,
    });

    await expect(
      service.findPublishedListingOrThrow(LISTING_ID),
    ).resolves.toEqual({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: PUBLISHED_AT,
    });
    expect(prismaMock.publicListingProjection.findFirst).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      select: { id: true, publishedAt: true },
    });
  });

  it('throws NotFoundException when the listing is not publicly accessible', async () => {
    prismaMock.publicListingProjection.findFirst.mockResolvedValue(null);

    await expect(
      service.findPublishedListingOrThrow(LISTING_ID),
    ).rejects.toThrow(NotFoundException);
  });
});
