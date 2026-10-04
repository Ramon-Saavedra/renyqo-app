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
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
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
    updateMany: jest.MockedFunction<
      (args?: unknown) => Promise<{ count: number }>
    >;
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
  let activityService: jest.Mocked<
    Pick<
      ApplicationActivityService,
      'appendWithinTransaction' | 'appendManyWithinTransaction'
    >
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
        updateMany: jest.fn<(args?: unknown) => Promise<{ count: number }>>(),
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
    activityService = {
      appendWithinTransaction: jest.fn(),
      appendManyWithinTransaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        {
          provide: ApplicationActivityService,
          useValue: activityService,
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

  const completeDraft = (overrides: Partial<Listing> = {}): Listing =>
    makeRawListing({
      title: 'Beautiful Apartment',
      street: 'Hauptstraße 1',
      livingArea: 65.5,
      rooms: 3,
      bedrooms: 2,
      coldRent: 1200,
      availableFrom: new Date('2024-06-01'),
      ...overrides,
    });

  function mockStatusWrite(source: Listing, result: Listing): void {
    prismaMock.listing.findFirst
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(result);
    prismaMock.listing.updateMany.mockResolvedValue({ count: 1 });
  }

  describe('publish', () => {
    it('throws UnprocessableEntityException with missingFields when required fields are absent', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(makeRawListing());

      await expect(service.publish(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    });

    it('sets publishedAt when a complete draft has never been published', async () => {
      const listing = completeDraft();
      const publishedAt = new Date('2024-06-02T00:00:00.000Z');
      const published = {
        ...listing,
        status: ListingStatus.PUBLISHED,
        publishedAt,
      };
      mockStatusWrite(listing, published);

      const result = await service.publish(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: LISTING_ID,
            providerId: PROVIDER_ID,
            status: ListingStatus.DRAFT,
            publishedAt: null,
          },
          data: {
            status: ListingStatus.PUBLISHED,
            publishedAt: expect.any(Date),
          },
        }),
      );
      expect(result.status).toBe(ListingStatus.PUBLISHED);
    });

    it('preserves an existing publishedAt when publishing a draft again', async () => {
      const publishedAt = new Date('2020-01-01T00:00:00.000Z');
      const listing = completeDraft({ publishedAt });
      mockStatusWrite(listing, {
        ...listing,
        status: ListingStatus.PUBLISHED,
      });

      await service.publish(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ListingStatus.PUBLISHED },
        }),
      );
    });

    it.each([
      ListingStatus.PUBLISHED,
      ListingStatus.PAUSED,
      ListingStatus.ARCHIVED,
      ListingStatus.RENTED,
    ])('rejects publish from %s', async (status) => {
      prismaMock.listing.findFirst.mockResolvedValue(completeDraft({ status }));

      await expect(service.publish(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    });

    it('returns a conflict when publish loses a concurrent transition', async () => {
      prismaMock.listing.findFirst
        .mockResolvedValueOnce(completeDraft())
        .mockResolvedValueOnce(
          completeDraft({ status: ListingStatus.ARCHIVED }),
        );
      prismaMock.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.publish(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('moveToDraft', () => {
    it.each([ListingStatus.PUBLISHED, ListingStatus.PAUSED])(
      'moves %s back to draft without changing publishedAt',
      async (status) => {
        const publishedAt = new Date('2020-01-01T00:00:00.000Z');
        const listing = makeRawListing({ status, publishedAt });
        mockStatusWrite(listing, {
          ...listing,
          status: ListingStatus.DRAFT,
        });

        const result = await service.moveToDraft(LISTING_ID, PROVIDER_ID);

        expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: LISTING_ID,
              providerId: PROVIDER_ID,
              status,
            },
            data: { status: ListingStatus.DRAFT },
          }),
        );
        expect(result.status).toBe(ListingStatus.DRAFT);
        expect(result.publishedAt).toEqual(publishedAt);
      },
    );

    it.each([
      ListingStatus.DRAFT,
      ListingStatus.ARCHIVED,
      ListingStatus.RENTED,
    ])('rejects draft from %s', async (status) => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeRawListing({ status }),
      );

      await expect(
        service.moveToDraft(LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(ConflictException);
      expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('pause', () => {
    it('pauses a published listing and preserves publishedAt', async () => {
      const publishedAt = new Date('2020-01-01T00:00:00.000Z');
      const listing = makeRawListing({
        status: ListingStatus.PUBLISHED,
        publishedAt,
      });
      mockStatusWrite(listing, { ...listing, status: ListingStatus.PAUSED });

      const result = await service.pause(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: LISTING_ID,
            providerId: PROVIDER_ID,
            status: ListingStatus.PUBLISHED,
          },
          data: { status: ListingStatus.PAUSED },
        }),
      );
      expect(result.status).toBe(ListingStatus.PAUSED);
      expect(result.publishedAt).toEqual(publishedAt);
    });

    it.each([
      ListingStatus.DRAFT,
      ListingStatus.PAUSED,
      ListingStatus.ARCHIVED,
      ListingStatus.RENTED,
    ])('rejects pause from %s', async (status) => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeRawListing({ status }),
      );

      await expect(service.pause(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the listing is not owned', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.pause(OTHER_LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns a conflict when pause loses a concurrent transition', async () => {
      prismaMock.listing.findFirst
        .mockResolvedValueOnce(
          makeRawListing({ status: ListingStatus.PUBLISHED }),
        )
        .mockResolvedValueOnce(
          makeRawListing({ status: ListingStatus.RENTED }),
        );
      prismaMock.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.pause(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('resume', () => {
    it('resumes a paused listing without changing publishedAt', async () => {
      const publishedAt = new Date('2020-01-01T00:00:00.000Z');
      const listing = makeRawListing({
        status: ListingStatus.PAUSED,
        publishedAt,
      });
      mockStatusWrite(listing, {
        ...listing,
        status: ListingStatus.PUBLISHED,
      });

      const result = await service.resume(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: LISTING_ID,
            providerId: PROVIDER_ID,
            status: ListingStatus.PAUSED,
          },
          data: { status: ListingStatus.PUBLISHED },
        }),
      );
      expect(result.status).toBe(ListingStatus.PUBLISHED);
      expect(result.publishedAt).toEqual(publishedAt);
    });

    it.each([
      ListingStatus.DRAFT,
      ListingStatus.PUBLISHED,
      ListingStatus.ARCHIVED,
      ListingStatus.RENTED,
    ])('rejects resume from %s', async (status) => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeRawListing({ status }),
      );

      await expect(service.resume(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it.each([
      ListingStatus.DRAFT,
      ListingStatus.PUBLISHED,
      ListingStatus.PAUSED,
    ])('archives %s without changing publishedAt', async (status) => {
      const publishedAt = new Date('2020-01-01T00:00:00.000Z');
      const listing = makeRawListing({ status, publishedAt });
      mockStatusWrite(listing, {
        ...listing,
        status: ListingStatus.ARCHIVED,
      });

      const result = await service.archive(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: LISTING_ID,
            providerId: PROVIDER_ID,
            status,
          },
          data: { status: ListingStatus.ARCHIVED },
        }),
      );
      expect(result.status).toBe(ListingStatus.ARCHIVED);
      expect(result.publishedAt).toEqual(publishedAt);
    });

    it.each([ListingStatus.ARCHIVED, ListingStatus.RENTED])(
      'rejects archive from %s',
      async (status) => {
        prismaMock.listing.findFirst.mockResolvedValue(
          makeRawListing({ status }),
        );

        await expect(service.archive(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
          ConflictException,
        );
        expect(prismaMock.listing.updateMany).not.toHaveBeenCalled();
      },
    );

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.archive(OTHER_LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns not found when a concurrent delete wins the conditional update', async () => {
      prismaMock.listing.findFirst
        .mockResolvedValueOnce(
          makeRawListing({ status: ListingStatus.PUBLISHED }),
        )
        .mockResolvedValueOnce(null);
      prismaMock.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.archive(LISTING_ID, PROVIDER_ID)).rejects.toThrow(
        NotFoundException,
      );
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
      expect(activityService.appendWithinTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          applicationId: APPLICATION_ID,
          type: ApplicationActivityType.APPLICATION_ACCEPTED,
          metadata: {
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.ACCEPTED,
          },
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

    it.each([ListingStatus.ARCHIVED, ListingStatus.RENTED])(
      'throws ConflictException when listing is %s',
      async (status) => {
        prismaMock.$queryRaw.mockResolvedValue([]);
        prismaMock.listing.findFirst.mockResolvedValue(
          makeRawListing({ status }),
        );

        await expect(
          service.rentListing(LISTING_ID, PROVIDER_ID, dto),
        ).rejects.toThrow(ConflictException);
        expect(prismaMock.listing.update).not.toHaveBeenCalled();
      },
    );

    it('marks a paused listing as rented without changing publishedAt', async () => {
      const publishedAt = new Date('2020-01-01T00:00:00.000Z');
      const listing = makeRawListing({
        status: ListingStatus.PAUSED,
        publishedAt,
      });
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

      expect(result.publishedAt).toEqual(publishedAt);
      expect(prismaMock.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ListingStatus.RENTED, rentedAt: expect.any(Date) },
        }),
      );
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
      const otherApps = [
        { id: 'other-1', status: ApplicationStatus.ACTIVE },
        { id: 'other-2', status: ApplicationStatus.WAITING },
      ];
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
      expect(activityService.appendManyWithinTransaction).toHaveBeenCalledWith(
        expect.anything(),
        [
          expect.objectContaining({
            applicationId: 'other-1',
            type: ApplicationActivityType.APPLICATION_REJECTED,
            visibility: ApplicationActivityVisibility.BOTH,
            metadata: expect.objectContaining({
              fromStatus: ApplicationStatus.ACTIVE,
              toStatus: ApplicationStatus.REJECTED,
              reason: ApplicationRejectionReason.LISTING_RENTED,
            }),
          }),
          expect.objectContaining({
            applicationId: 'other-2',
            type: ApplicationActivityType.APPLICATION_REJECTED,
            visibility: ApplicationActivityVisibility.APPLICANT,
            metadata: expect.objectContaining({
              fromStatus: ApplicationStatus.WAITING,
              toStatus: ApplicationStatus.REJECTED,
              reason: ApplicationRejectionReason.LISTING_RENTED,
            }),
          }),
        ],
      );
      expect(activityService.appendWithinTransaction).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: ApplicationActivityType.APPLICATION_REJECTED,
        }),
      );
    });
  });
});
