import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
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
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
  ObjectType,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
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

  describe('publish', () => {
    it('throws UnprocessableEntityException with missingFields when required fields are absent', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(service.publish(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
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

      const result = await service.publish(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LISTING_ID },
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

      const result = await service.moveToDraft(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ListingStatus.DRAFT },
        }),
      );
      expect(result.status).toBe(ListingStatus.DRAFT);
    });
  });

  describe('archive', () => {
    it('sets listing status to ARCHIVED', async () => {
      const listing = makeRawListing({ status: ListingStatus.PUBLISHED });
      const archived = { ...listing, status: ListingStatus.ARCHIVED };
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(archived);

      const result = await service.archive(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LISTING_ID },
          data: { status: ListingStatus.ARCHIVED },
        }),
      );
      expect(result.status).toBe(ListingStatus.ARCHIVED);
    });

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.archive(OTHER_LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rentListing', () => {
    const APPLICATION_ID = '00000000-0000-4000-8000-000000000099';
    const dto = { selectedApplicationId: APPLICATION_ID };

    it('marks listing as RENTED, accepts selected app, rejects others', async () => {
      const listing = makeRawListing({ status: ListingStatus.PUBLISHED });
      const rentedListing = {
        ...listing,
        status: ListingStatus.RENTED,
        rentedAt: new Date(),
      };
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findUnique.mockResolvedValue({
        id: APPLICATION_ID,
        listingId: LISTING_ID,
        status: ApplicationStatus.ACTIVE,
      });
      prismaMock.application.findMany.mockResolvedValue([]);
      prismaMock.application.update.mockResolvedValue({});
      prismaMock.listing.update.mockResolvedValue(rentedListing);

      const result = await service.rentListing(LISTING_ID, PROVIDER_ID, dto);

      expect(result.status).toBe(ListingStatus.RENTED);
      expect(prismaMock.application.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: APPLICATION_ID },
          data: { status: ApplicationStatus.ACCEPTED },
        }),
      );
      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: LISTING_ID },
          data: expect.objectContaining({ status: ListingStatus.RENTED }),
        }),
      );
    });

    it('throws NotFoundException when listing does not belong to provider', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.rentListing(LISTING_ID, PROVIDER_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when listing is DRAFT', async () => {
      const listing = makeRawListing({ status: ListingStatus.DRAFT });
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.rentListing(LISTING_ID, PROVIDER_ID, dto),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when selected application is not ACTIVE', async () => {
      const listing = makeRawListing({ status: ListingStatus.PUBLISHED });
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findUnique.mockResolvedValue({
        id: APPLICATION_ID,
        listingId: LISTING_ID,
        status: ApplicationStatus.REJECTED,
      });

      await expect(
        service.rentListing(LISTING_ID, PROVIDER_ID, dto),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects remaining ACTIVE and WAITING applications with LISTING_RENTED', async () => {
      const listing = makeRawListing({ status: ListingStatus.PUBLISHED });
      const rentedListing = {
        ...listing,
        status: ListingStatus.RENTED,
        rentedAt: new Date(),
      };
      const otherApps = [{ id: 'other-1' }, { id: 'other-2' }];
      prismaMock.$queryRaw.mockResolvedValue([]);
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findUnique.mockResolvedValue({
        id: APPLICATION_ID,
        listingId: LISTING_ID,
        status: ApplicationStatus.ACTIVE,
      });
      prismaMock.application.findMany.mockResolvedValue(otherApps);
      prismaMock.application.update.mockResolvedValue({});
      prismaMock.application.updateMany =
        jest.fn<(args?: unknown) => Promise<unknown>>();
      prismaMock.listing.update.mockResolvedValue(rentedListing);

      const result = await service.rentListing(LISTING_ID, PROVIDER_ID, dto);

      expect(result.status).toBe(ListingStatus.RENTED);
      expect(prismaMock.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['other-1', 'other-2'] } },
          data: expect.objectContaining({
            status: ApplicationStatus.REJECTED,
            publicReason: ApplicationRejectionReason.LISTING_RENTED,
            rejectedAt: expect.any(Date),
          }),
        }),
      );
    });
  });
});
