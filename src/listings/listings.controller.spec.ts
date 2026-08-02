import { Test, TestingModule } from '@nestjs/testing';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ListingStatus, ObjectType } from '../generated/prisma/enums';
import type { Listing } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { Role, UserStatus } from '../generated/prisma/enums';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import { RentListingDto } from './dto/rent-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';

const makeProviderUser = (): SafeUser => ({
  id: PROVIDER_ID,
  name: 'Provider User',
  email: 'provider@example.com',
  role: Role.PROVIDER,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const makeListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: LISTING_ID,
  providerId: PROVIDER_ID,
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
  depositMonths: 2,
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
  rentedAt: null,
  ...overrides,
});

type RouteArgMetadata = {
  index: number;
  data?: string;
  pipes?: readonly unknown[];
};

const getRouteArgMetadata = (
  methodName: string,
  parameterIndex: number,
): RouteArgMetadata | undefined => {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ListingsController,
    methodName,
  ) as Record<string, RouteArgMetadata> | undefined;

  return Object.values(metadata ?? {}).find(
    (routeArgMetadata) => routeArgMetadata.index === parameterIndex,
  );
};

describe('ListingsController', () => {
  let controller: ListingsController;
  let listingsService: jest.Mocked<ListingsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ListingsController],
      providers: [
        {
          provide: ListingsService,
          useValue: {
            create: jest.fn(),
            findAllByProvider: jest.fn(),
            findOneByProvider: jest.fn(),
            findOneDetailByProvider: jest.fn(),
            update: jest.fn(),
            publish: jest.fn(),
            moveToDraft: jest.fn(),
            archive: jest.fn(),
            rentListing: jest.fn(),
            toListingResponse: jest.fn(
              (listing: Listing) =>
                new ListingResponseDto(listing, { exposeExactAddress: true }),
            ),
            toListingResponses: jest.fn((listings: readonly Listing[]) =>
              listings.map(
                (listing) =>
                  new ListingResponseDto(listing, {
                    exposeExactAddress: true,
                  }),
              ),
            ),
          },
        },
      ],
    }).compile();

    controller = module.get<ListingsController>(ListingsController);
    listingsService = module.get(ListingsService);
  });

  describe('create', () => {
    it('calls listingsService.create with provider id and dto', async () => {
      const listing = makeListing();
      const dto: CreateListingDto = {
        objectType: ObjectType.APARTMENT,
        city: 'Berlin',
        zip: '10115',
      };
      listingsService.create.mockResolvedValue(listing);

      const result = await controller.create(
        dto,
        undefined,
        makeProviderUser(),
      );

      expect(listingsService.create).toHaveBeenCalledWith(
        PROVIDER_ID,
        dto,
        undefined,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result).toEqual(listing);
    });
  });

  describe('findAll', () => {
    it('calls listingsService.findAllByProvider with provider id', async () => {
      const listings = [makeListing()];
      listingsService.findAllByProvider.mockResolvedValue(listings);

      const result = await controller.findAll(makeProviderUser());

      expect(listingsService.findAllByProvider).toHaveBeenCalledWith(
        PROVIDER_ID,
      );
      expect(listingsService.toListingResponses).toHaveBeenCalledWith(
        listings,
        { exposeExactAddress: true },
      );
      expect(result).toEqual(listings);
    });
  });

  describe('findOne', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('findOne', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls listingsService.findOneDetailByProvider with id and provider id', async () => {
      const listing = { ...makeListing(), images: [] };
      listingsService.findOneDetailByProvider.mockResolvedValue(listing);

      const result = await controller.findOne(LISTING_ID, makeProviderUser());

      expect(listingsService.findOneDetailByProvider).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result).toEqual(listing);
    });

    it('returns the listing images with real ids and metadata', async () => {
      const image = {
        id: '00000000-0000-4000-8000-000000000009',
        listingId: LISTING_ID,
        publicId: 'renyqo/listings/abc/xyz',
        secureUrl: 'https://res.cloudinary.com/test/image/upload/xyz.jpg',
        position: 0,
        isCover: true,
        createdAt: new Date('2024-01-01'),
      };
      const listing = { ...makeListing(), images: [image] };
      listingsService.findOneDetailByProvider.mockResolvedValue(listing);

      const result = await controller.findOne(LISTING_ID, makeProviderUser());

      expect(result.images).toEqual([
        {
          id: image.id,
          secureUrl: image.secureUrl,
          position: 0,
          isCover: true,
        },
      ]);
    });
  });

  describe('update', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('update', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls listingsService.update with id, provider id and dto', async () => {
      const listing = makeListing({ title: 'Updated' });
      const dto: UpdateListingDto = { title: 'Updated' };
      listingsService.update.mockResolvedValue(listing);

      const result = await controller.update(
        LISTING_ID,
        dto,
        makeProviderUser(),
      );

      expect(listingsService.update).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
        dto,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result).toEqual(listing);
    });
  });

  describe('publish', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('publish', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls listingsService.publish with id and provider id', async () => {
      const listing = makeListing({ status: ListingStatus.PUBLISHED });
      listingsService.publish.mockResolvedValue(listing);

      const result = await controller.publish(LISTING_ID, makeProviderUser());

      expect(listingsService.publish).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result.status).toBe(ListingStatus.PUBLISHED);
    });
  });

  describe('moveToDraft', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('moveToDraft', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls listingsService.moveToDraft with id and provider id', async () => {
      const listing = makeListing({ status: ListingStatus.DRAFT });
      listingsService.moveToDraft.mockResolvedValue(listing);

      const result = await controller.moveToDraft(
        LISTING_ID,
        makeProviderUser(),
      );

      expect(listingsService.moveToDraft).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result.status).toBe(ListingStatus.DRAFT);
    });
  });

  describe('archive', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('archive', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls listingsService.archive with id and provider id', async () => {
      const listing = makeListing({ status: ListingStatus.ARCHIVED });
      listingsService.archive.mockResolvedValue(listing);

      const result = await controller.archive(LISTING_ID, makeProviderUser());

      expect(listingsService.archive).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result.status).toBe(ListingStatus.ARCHIVED);
    });
  });

  describe('rent', () => {
    it('calls listingsService.rentListing with id, provider id and dto', async () => {
      const dto: RentListingDto = {
        selectedApplicationId: '00000000-0000-4000-8000-000000000099',
      };
      const listing = makeListing({ status: ListingStatus.RENTED });
      listingsService.rentListing.mockResolvedValue(listing);

      const result = await controller.rent(LISTING_ID, dto, makeProviderUser());

      expect(listingsService.rentListing).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
        dto,
      );
      expect(listingsService.toListingResponse).toHaveBeenCalledWith(listing, {
        exposeExactAddress: true,
      });
      expect(result.status).toBe(ListingStatus.RENTED);
    });
  });
});
