import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Listing } from '../generated/prisma/client';
import { ListingStatus, ObjectType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import type { CreateListingDto } from './dto/create-listing.dto';

const makeRawListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'listing-uuid',
  providerId: 'provider-uuid',
  status: ListingStatus.DRAFT,
  city: 'Berlin',
  zip: '10115',
  street: null,
  country: 'DE',
  showExactAddress: false,
  objectType: ObjectType.APARTMENT,
  livingArea: null,
  rooms: null,
  bedrooms: null,
  coldRent: null,
  additionalCosts: null,
  deposit: null,
  availableFrom: null,
  title: null,
  shortDescription: null,
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: null,
  ...overrides,
});

describe('ListingsService', () => {
  let service: ListingsService;
  let prismaMock: {
    listing: {
      create: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
      findMany: jest.MockedFunction<(args?: unknown) => Promise<Listing[]>>;
      findFirst: jest.MockedFunction<
        (args?: unknown) => Promise<Listing | null>
      >;
      update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
      count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<Listing[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest.fn<(args?: unknown) => Promise<number>>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  describe('create', () => {
    it('creates a listing with providerId and dto data', async () => {
      const listing = makeRawListing();
      prismaMock.listing.create.mockResolvedValue(listing);

      const dto: CreateListingDto = {
        objectType: ObjectType.APARTMENT,
        city: 'Berlin',
        zip: '10115',
      };

      const result = await service.create('provider-uuid', dto);

      expect(prismaMock.listing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerId: 'provider-uuid',
            objectType: ObjectType.APARTMENT,
            city: 'Berlin',
            zip: '10115',
          }),
        }),
      );
      expect(result).toEqual(listing);
    });
  });

  describe('findAllByProvider', () => {
    it('returns all listings for a provider ordered by createdAt desc', async () => {
      const listings = [makeRawListing(), makeRawListing({ id: 'listing-2' })];
      prismaMock.listing.findMany.mockResolvedValue(listings);

      const result = await service.findAllByProvider('provider-uuid');

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: 'provider-uuid' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result).toEqual(listings);
    });
  });

  describe('findOneByProvider', () => {
    it('returns the listing when it belongs to the provider', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      const result = await service.findOneByProvider(
        'listing-uuid',
        'provider-uuid',
      );

      expect(result).toEqual(listing);
    });

    it('throws NotFoundException when listing is not found', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findOneByProvider('other-uuid', 'provider-uuid'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('publish', () => {
    it('throws UnprocessableEntityException with missingFields when required fields are absent', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.publish('listing-uuid', 'provider-uuid'),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('publishes the listing when all required fields are present', async () => {
      const listing = makeRawListing({
        title: 'Beautiful Apartment',
        street: 'Hauptstraße 1',
        livingArea: 65.5,
        rooms: 3,
        bedrooms: 2,
        coldRent: 1200,
        availableFrom: new Date('2024-06-01'),
      });
      const published = { ...listing, status: ListingStatus.PUBLISHED };
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(published);

      const result = await service.publish('listing-uuid', 'provider-uuid');

      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'listing-uuid' },
          data: expect.objectContaining({ status: ListingStatus.PUBLISHED }),
        }),
      );
      expect(result.status).toBe(ListingStatus.PUBLISHED);
    });
  });

  describe('moveToDraft', () => {
    it('moves a published listing back to draft', async () => {
      const listing = makeRawListing({ status: ListingStatus.PUBLISHED });
      const drafted = { ...listing, status: ListingStatus.DRAFT };
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(drafted);

      const result = await service.moveToDraft('listing-uuid', 'provider-uuid');

      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ListingStatus.DRAFT },
        }),
      );
      expect(result.status).toBe(ListingStatus.DRAFT);
    });
  });

  describe('countByProvider', () => {
    it('returns the number of listings for a provider', async () => {
      prismaMock.listing.count.mockResolvedValue(3);

      const result = await service.countByProvider('provider-uuid');

      expect(prismaMock.listing.count).toHaveBeenCalledWith({
        where: { providerId: 'provider-uuid' },
      });
      expect(result).toBe(3);
    });
  });
});
