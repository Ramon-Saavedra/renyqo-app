import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UploadApiResponse } from 'cloudinary';

import type {
  ApplicantProfile,
  Listing,
  ListingImage,
} from '../generated/prisma/client';
import {
  ApplicationStatus,
  ListingStatus,
  ObjectType,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const LISTING_ID_2 = '00000000-0000-4000-8000-000000000003';
const OTHER_LISTING_ID = '00000000-0000-4000-8000-000000000004';
const CLOUDINARY_FOLDER = 'renyqo';

type ListingsTransactionMock = {
  listing: {
    create: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    findFirst: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<Listing | null>
    >;
    update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
    aggregate: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  listingImage: {
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
  };
  application: {
    findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    updateMany: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    update: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  $queryRaw: jest.MockedFunction<(query: unknown) => Promise<unknown>>;
};

type PrismaTransactionRunner = (
  fn: (tx: ListingsTransactionMock) => Promise<unknown>,
) => Promise<unknown>;

type PrismaMock = ListingsTransactionMock & {
  $transaction: jest.MockedFunction<PrismaTransactionRunner>;
  applicantProfile: {
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<ApplicantProfile | null>
    >;
  };
};

const makeRawListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: LISTING_ID,
  providerId: PROVIDER_ID,
  status: ListingStatus.DRAFT,
  city: 'Berlin',
  zip: '10115',
  street: null,
  district: null,
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
  displayOrder: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: null,
  rentedAt: null,
  ...overrides,
});

const makeRawListingImage = (
  overrides: Partial<ListingImage> = {},
): ListingImage => ({
  id: '00000000-0000-4000-8000-000000000020',
  listingId: LISTING_ID,
  publicId: `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc123`,
  secureUrl: 'https://res.cloudinary.com/test/image/upload/abc123.jpg',
  position: 0,
  isCover: true,
  createdAt: new Date('2024-01-01'),
  ...overrides,
});
describe('ListingsService', () => {
  let service: ListingsService;
  let prismaMock: PrismaMock;
  let cloudinaryMock: jest.Mocked<
    Pick<CloudinaryService, 'uploadBuffer' | 'deleteByPublicId'>
  >;
  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = (fn) =>
      Promise.resolve(fn(prismaMock));

    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findUnique: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest
          .fn<(args?: unknown) => Promise<number>>()
          .mockResolvedValue(0),
        aggregate: jest
          .fn<(args?: unknown) => Promise<unknown>>()
          .mockResolvedValue({ _max: { displayOrder: 0 } }),
      },
      listingImage: {
        create: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
      },
      application: {
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        updateMany: jest.fn<(args?: unknown) => Promise<unknown>>(),
        update: jest.fn<(args?: unknown) => Promise<unknown>>(),
      },
      $queryRaw: jest.fn<(query: unknown) => Promise<unknown>>(),
      $transaction: jest.fn<PrismaTransactionRunner>(transactionRunner),
      applicantProfile: {
        findUnique: jest
          .fn<(args?: unknown) => Promise<ApplicantProfile | null>>()
          .mockResolvedValue(null),
      },
    };

    cloudinaryMock = {
      uploadBuffer:
        jest.fn<
          (buffer: Buffer, folder: string) => Promise<UploadApiResponse>
        >(),
      deleteByPublicId: jest.fn<(publicId: string) => Promise<void>>(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        {
          provide: ApplicationActivityService,
          useValue: { appendWithinTransaction: jest.fn() },
        },
        {
          provide: ListingOrderingService,
          useValue: {
            getNextDisplayOrder: jest.fn(() => Promise.resolve(1)),
            move: jest.fn(),
          },
        },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: CloudinaryService,
          useValue: cloudinaryMock,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
        },
        ListingInputRules,
        ListingResponseMapper,
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  describe('findAllByProvider', () => {
    it('returns all listings for a provider ordered by displayOrder with ACTIVE application counts', async () => {
      const listings = [
        { ...makeRawListing(), _count: { applications: 2 } },
        {
          ...makeRawListing({ id: LISTING_ID_2 }),
          _count: { applications: 0 },
        },
      ];
      prismaMock.listing.findMany.mockResolvedValue(listings);

      const result = await service.findAllByProvider(PROVIDER_ID);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: PROVIDER_ID },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          include: {
            _count: {
              select: {
                applications: {
                  where: { status: ApplicationStatus.ACTIVE },
                },
              },
            },
          },
        }),
      );
      expect(result).toEqual(listings);
    });
  });

  describe('toProviderListingOverviewResponses', () => {
    it('maps each listing activeApplicationsCount without exposing _count', () => {
      const listings = [
        { ...makeRawListing(), _count: { applications: 0 } },
        {
          ...makeRawListing({ id: LISTING_ID_2 }),
          _count: { applications: 5 },
        },
      ];

      const result = service.toProviderListingOverviewResponses(listings, {
        exposeExactAddress: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0].activeApplicationsCount).toBe(0);
      expect(result[1].activeApplicationsCount).toBe(5);
      expect(result[0]).not.toHaveProperty('_count');
      expect(result[1]).not.toHaveProperty('_count');
    });
  });

  describe('findOneByProvider', () => {
    it('returns the listing when it belongs to the provider', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      const result = await service.findOneByProvider(LISTING_ID, PROVIDER_ID);

      expect(result).toEqual(listing);
    });

    it('throws NotFoundException when listing is not found', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findOneByProvider(OTHER_LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOneDetailByProvider', () => {
    it('returns the listing with its images ordered by position', async () => {
      const images = [
        makeRawListingImage(),
        makeRawListingImage({
          id: '00000000-0000-4000-8000-000000000021',
          position: 1,
          isCover: false,
        }),
      ];
      const listing = { ...makeRawListing(), images };
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      const result = await service.findOneDetailByProvider(
        LISTING_ID,
        PROVIDER_ID,
      );

      expect(prismaMock.listing.findFirst).toHaveBeenCalledWith({
        where: { id: LISTING_ID, providerId: PROVIDER_ID },
        include: { images: { orderBy: { position: 'asc' } } },
      });
      expect(result).toEqual(listing);
    });

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findOneDetailByProvider(OTHER_LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('toListingResponse', () => {
    it('maps images to id, secureUrl, position and isCover only', () => {
      const listing = {
        ...makeRawListing(),
        images: [makeRawListingImage()],
      };

      const result = service.toListingResponse(listing);

      expect(result.images).toEqual([
        {
          id: '00000000-0000-4000-8000-000000000020',
          secureUrl: 'https://res.cloudinary.com/test/image/upload/abc123.jpg',
          position: 0,
          isCover: true,
        },
      ]);
    });

    it('omits images when the listing record has none loaded', () => {
      const result = service.toListingResponse(makeRawListing());

      expect(result.images).toBeUndefined();
    });

    it('hides street when showExactAddress is false by default', () => {
      const listing = makeRawListing({
        street: 'Hauptstraße 1',
        showExactAddress: false,
      });

      const result = service.toListingResponse(listing);

      expect(result.street).toBeNull();
      expect(result.city).toBe(listing.city);
      expect(result.showExactAddress).toBe(false);
    });

    it('keeps street when showExactAddress is true', () => {
      const listing = makeRawListing({
        street: 'Hauptstraße 1',
        showExactAddress: true,
      });

      const result = service.toListingResponse(listing);

      expect(result.street).toBe('Hauptstraße 1');
    });

    it('keeps street when exact address exposure is explicitly allowed', () => {
      const listing = makeRawListing({
        street: 'Hauptstraße 1',
        showExactAddress: false,
      });

      const result = service.toListingResponse(listing, {
        exposeExactAddress: true,
      });

      expect(result.street).toBe('Hauptstraße 1');
    });
  });

  describe('toListingResponses', () => {
    it('maps all listings through toListingResponse', () => {
      const listings = [
        makeRawListing({
          id: LISTING_ID,
          street: 'Hauptstraße 1',
          showExactAddress: false,
        }),
        makeRawListing({
          id: LISTING_ID_2,
          street: 'Nebenstraße 2',
          showExactAddress: true,
        }),
      ];

      const result = service.toListingResponses(listings);

      expect(result).toHaveLength(2);
      expect(result[0]?.street).toBeNull();
      expect(result[1]?.street).toBe('Nebenstraße 2');
    });
  });

  describe('countByProvider', () => {
    it('returns the number of listings for a provider', async () => {
      prismaMock.listing.count.mockResolvedValue(3);

      const result = await service.countByProvider(PROVIDER_ID);

      expect(prismaMock.listing.count).toHaveBeenCalledWith({
        where: { providerId: PROVIDER_ID },
      });
      expect(result).toBe(3);
    });
  });

  describe('countDraftsByProvider', () => {
    it('returns the number of draft listings for a provider', async () => {
      prismaMock.listing.count.mockResolvedValue(2);

      const result = await service.countDraftsByProvider(PROVIDER_ID);

      expect(prismaMock.listing.count).toHaveBeenCalledWith({
        where: { providerId: PROVIDER_ID, status: ListingStatus.DRAFT },
      });
      expect(result).toBe(2);
    });
  });

  describe('findRecentByProvider', () => {
    it('returns recent listings limited to the given count', async () => {
      const listings = [makeRawListing(), makeRawListing({ id: LISTING_ID_2 })];
      prismaMock.listing.findMany.mockResolvedValue(listings);

      const result = await service.findRecentByProvider(PROVIDER_ID, 5);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: PROVIDER_ID },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      );
      expect(result).toEqual(listings);
    });
  });
});
