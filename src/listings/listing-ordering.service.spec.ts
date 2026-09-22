import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Listing, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListingOrderingService } from './listing-ordering.service';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_PROVIDER_ID = '00000000-0000-4000-8000-000000000002';
const LISTING_ID = '00000000-0000-4000-8000-000000000003';

type ListingClientMock = {
  findFirst: jest.MockedFunction<
    (args: unknown) => Promise<{ id: string; displayOrder: number } | null>
  >;
  findUnique: jest.MockedFunction<(args: unknown) => Promise<Listing | null>>;
  count: jest.MockedFunction<(args: unknown) => Promise<number>>;
  update: jest.MockedFunction<(args: unknown) => Promise<Listing>>;
  updateMany: jest.MockedFunction<
    (args: unknown) => Promise<{ count: number }>
  >;
  aggregate: jest.MockedFunction<(args: unknown) => Promise<unknown>>;
};

type TransactionMock = {
  listing: ListingClientMock;
  $queryRaw: jest.MockedFunction<(query: unknown) => Promise<unknown>>;
};

describe('ListingOrderingService', () => {
  let service: ListingOrderingService;
  let tx: TransactionMock;
  let prisma: Pick<PrismaService, '$transaction'>;
  const listing = { id: LISTING_ID, displayOrder: 5 };
  const updatedListing = { ...listing, providerId: PROVIDER_ID } as Listing;

  beforeEach(() => {
    tx = {
      $queryRaw: jest
        .fn<(query: unknown) => Promise<unknown>>()
        .mockResolvedValue([]),
      listing: {
        findFirst: jest
          .fn<
            (
              args: unknown,
            ) => Promise<{ id: string; displayOrder: number } | null>
          >()
          .mockResolvedValue(listing),
        findUnique: jest
          .fn<(args: unknown) => Promise<Listing | null>>()
          .mockResolvedValue(updatedListing),
        count: jest
          .fn<(args: unknown) => Promise<number>>()
          .mockResolvedValue(20),
        update: jest
          .fn<(args: unknown) => Promise<Listing>>()
          .mockResolvedValue(updatedListing),
        updateMany: jest
          .fn<(args: unknown) => Promise<{ count: number }>>()
          .mockResolvedValue({ count: 0 }),
        aggregate: jest
          .fn<(args: unknown) => Promise<unknown>>()
          .mockResolvedValue({ _max: { displayOrder: 20 } }),
      },
    };

    prisma = {
      $transaction: jest.fn(
        (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          Promise.resolve(operation(tx as unknown as Prisma.TransactionClient)),
      ),
    } as unknown as Pick<PrismaService, '$transaction'>;
    service = new ListingOrderingService(prisma as unknown as PrismaService);
  });

  it('shifts positions upward when moving 20 to 1', async () => {
    tx.listing.findFirst.mockResolvedValue({
      id: LISTING_ID,
      displayOrder: 20,
    });

    await service.move(LISTING_ID, PROVIDER_ID, 1);

    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gte: 1, lt: 20 },
      },
      data: { displayOrder: { increment: 21 } },
    });
    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gt: 21, lte: 40 },
      },
      data: { displayOrder: { decrement: 20 } },
    });
  });

  it('shifts positions downward when moving 1 to 20', async () => {
    tx.listing.findFirst.mockResolvedValue({ id: LISTING_ID, displayOrder: 1 });

    await service.move(LISTING_ID, PROVIDER_ID, 20);

    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gt: 1, lte: 20 },
      },
      data: { displayOrder: { decrement: 21 } },
    });
    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gte: -19, lte: -1 },
      },
      data: { displayOrder: { increment: 20 } },
    });
  });

  it('shifts the affected middle range when moving 5 to 8', async () => {
    await service.move(LISTING_ID, PROVIDER_ID, 8);

    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gt: 5, lte: 8 },
      },
      data: { displayOrder: { decrement: 21 } },
    });
    expect(tx.listing.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        providerId: PROVIDER_ID,
        displayOrder: { gte: -15, lte: -13 },
      },
      data: { displayOrder: { increment: 20 } },
    });
  });

  it('does nothing when moving to the current position', async () => {
    await service.move(LISTING_ID, PROVIDER_ID, 5);

    expect(tx.listing.update).not.toHaveBeenCalled();
    expect(tx.listing.updateMany).not.toHaveBeenCalled();
    expect(tx.listing.findUnique).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
    });
  });

  it('rejects positions outside the provider listing range', async () => {
    await expect(
      service.move(LISTING_ID, PROVIDER_ID, 21),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.listing.update).not.toHaveBeenCalled();
  });

  it('rejects a listing owned by another provider', async () => {
    tx.listing.findFirst.mockResolvedValue(null);

    await expect(
      service.move(LISTING_ID, OTHER_PROVIDER_ID, 1),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assigns the next appended display order', async () => {
    await expect(
      service.getNextDisplayOrder(
        tx as unknown as Prisma.TransactionClient,
        PROVIDER_ID,
      ),
    ).resolves.toBe(21);

    expect(tx.listing.aggregate).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID },
      _max: { displayOrder: true },
    });
  });
});
