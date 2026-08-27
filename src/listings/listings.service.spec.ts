import {
  BadRequestException,
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
  PetsPolicy,
  Role,
  SmokingPolicy,
  UserStatus,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { ProfileMatch } from './dto/applicant-listing-profile-match.enum';
import { PublicProviderType } from '../auth/dto/register.dto';
import type { SafeUser } from '../users/types/safe-user.type';
import { ListingsService } from './listings.service';
import type { CreateListingDto } from './dto/create-listing.dto';

function serialized<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

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
    update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
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

type ListingCreateArgs = {
  data: {
    id?: string;
    providerId?: string;
    objectType?: ObjectType;
    city?: string;
    zip?: string;
    coldRent?: number;
    deposit?: number;
    depositMonths?: number;
    title?: string;
    shortDescription?: string;
    photos?: string[];
  };
};

type ListingUpdateArgs = {
  data: {
    coldRent?: number;
    deposit?: number;
    depositMonths?: number;
    title?: string;
  };
};

type ListingImageCreateArgs = {
  data: {
    listingId: string;
    publicId: string;
    secureUrl: string;
    position: number;
    isCover: boolean;
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

const makeApplicantProfile = (
  overrides: Partial<ApplicantProfile> = {},
): ApplicantProfile => ({
  id: '00000000-0000-4000-8000-000000000004',
  applicantId: '00000000-0000-4000-8000-000000000099',
  householdNetIncome: null,
  incomeProofAvailable: null,
  schufaAvailable: null,
  peopleCount: null,
  adultsCount: null,
  childrenCount: null,
  hasPets: null,
  isSmoker: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const makeMulterFile = (): Express.Multer.File => ({
  fieldname: 'file',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  buffer: Buffer.from('fake-image'),
  size: 10,
  stream: null as unknown as import('stream').Readable,
  destination: '',
  filename: '',
  path: '',
});

const makeUploadResult = (): UploadApiResponse =>
  ({
    public_id: `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`,
    secure_url: 'https://res.cloudinary.com/test/image/upload/abc.jpg',
  }) as UploadApiResponse;

type DiscoveryListing = {
  id: string;
  title: string | null;
  city: string | null;
  zip: string | null;
  district: string | null;
  objectType: string | null;
  livingArea: number | null;
  rooms: number | null;
  bedrooms: number | null;
  coldRent: number | null;
  additionalCosts: number | null;
  deposit: number | null;
  depositMonths: number | null;
  availableFrom: Date | null;
  shortDescription: string | null;
  publishedAt: Date | null;
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean;
  incomeProofRequired: boolean;
  suitableForPeopleCount: number | null;
  petsPolicy: string | null;
  smokingPolicy: string | null;
  images: { secureUrl: string; position: number; isCover: boolean }[];
};

type DiscoveryDetail = DiscoveryListing & {
  district: string | null;
  street: string | null;
  showExactAddress: boolean;
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean;
  incomeProofRequired: boolean;
  suitableForPeopleCount: number | null;
  petsPolicy: string | null;
  smokingPolicy: string | null;
};

const makeDiscoveryListing = (
  overrides: Partial<DiscoveryListing> = {},
): DiscoveryListing => ({
  id: LISTING_ID,
  title: 'Test Listing',
  city: 'Berlin',
  zip: '10115',
  district: null,
  objectType: ObjectType.APARTMENT,
  livingArea: 62.5,
  rooms: 2,
  bedrooms: 1,
  coldRent: 1200,
  additionalCosts: 250,
  deposit: 2400,
  depositMonths: 2,
  availableFrom: new Date('2026-09-01'),
  shortDescription: 'Nice place',
  publishedAt: new Date('2026-07-01'),
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  images: [
    { secureUrl: 'https://example.com/cover.jpg', position: 0, isCover: true },
  ],
  ...overrides,
});

const makeDiscoveryDetail = (
  overrides: Partial<DiscoveryDetail> = {},
): DiscoveryDetail => ({
  ...makeDiscoveryListing(),
  district: 'Mitte',
  street: 'Hauptstrasse 1',
  showExactAddress: false,
  minimumHouseholdNetIncome: 3000,
  schufaRequired: true,
  incomeProofRequired: false,
  suitableForPeopleCount: 2,
  petsPolicy: PetsPolicy.ALLOWED,
  smokingPolicy: SmokingPolicy.NOT_ALLOWED,
  ...overrides,
});

describe('ListingsService', () => {
  let service: ListingsService;
  let prismaMock: PrismaMock;
  let cloudinaryMock: jest.Mocked<
    Pick<CloudinaryService, 'uploadBuffer' | 'deleteByPublicId'>
  >;
  let eligibilityMock: jest.Mocked<EligibilityService>;

  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = async (fn) =>
      fn(prismaMock);

    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest
          .fn<(args?: unknown) => Promise<number>>()
          .mockResolvedValue(0),
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
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: CloudinaryService,
          useValue: cloudinaryMock,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
        },
        {
          provide: EligibilityService,
          useValue: {
            isProfileComplete: jest.fn().mockReturnValue(false),
            evaluateCriteria: jest.fn().mockReturnValue({
              canApply: false,
              reasons: [],
              warnings: [],
              evaluatedAt: new Date(),
            }),
            buildHardMatchWhere: jest.fn().mockReturnValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
    eligibilityMock = module.get(EligibilityService);
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

      const result = await service.create(PROVIDER_ID, dto);

      expect(prismaMock.listing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerId: PROVIDER_ID,
            city: 'Berlin',
            zip: '10115',
          }),
        }),
      );
      expect(cloudinaryMock.uploadBuffer).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(result).toEqual(listing);
    });

    it('creates a partial draft with a single meaningful field', async () => {
      const listing = makeRawListing({
        city: null,
        zip: null,
        objectType: null,
        title: 'Draft title',
      });
      const dto: CreateListingDto = { title: 'Draft title' };
      prismaMock.listing.create.mockResolvedValue(listing);

      const result = await service.create(PROVIDER_ID, dto);

      expect(prismaMock.listing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerId: PROVIDER_ID,
            title: 'Draft title',
          }),
        }),
      );
      expect(result).toEqual(listing);
    });

    it('rejects an empty draft without a file', async () => {
      await expect(service.create(PROVIDER_ID, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.listing.create).not.toHaveBeenCalled();
    });

    it('calculates the default deposit as two cold rent months', async () => {
      const listing = makeRawListing({
        coldRent: 1200,
        deposit: 2400,
        depositMonths: 2,
      });
      const dto: CreateListingDto = { coldRent: 1200 };
      prismaMock.listing.create.mockResolvedValue(listing);

      await service.create(PROVIDER_ID, dto);

      const listingCreateArgs = prismaMock.listing.create.mock
        .calls[0][0] as ListingCreateArgs;

      expect(listingCreateArgs.data).toEqual(
        expect.objectContaining({
          coldRent: 1200,
          deposit: 2400,
          depositMonths: 2,
        }),
      );
    });

    it('calculates deposit from selected deposit months', async () => {
      const listing = makeRawListing({
        coldRent: 1200,
        deposit: 3600,
        depositMonths: 3,
      });
      const dto: CreateListingDto = { coldRent: 1200, depositMonths: 3 };
      prismaMock.listing.create.mockResolvedValue(listing);

      await service.create(PROVIDER_ID, dto);

      const listingCreateArgs = prismaMock.listing.create.mock
        .calls[0][0] as ListingCreateArgs;

      expect(listingCreateArgs.data).toEqual(
        expect.objectContaining({
          coldRent: 1200,
          deposit: 3600,
          depositMonths: 3,
        }),
      );
    });

    it('rejects a provided deposit that does not match cold rent months', async () => {
      const dto: CreateListingDto = {
        coldRent: 1200,
        depositMonths: 2,
        deposit: 3600,
      };

      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.listing.create).not.toHaveBeenCalled();
    });

    it('rejects a deposit without cold rent', async () => {
      const dto: CreateListingDto = { deposit: 2400 };

      await expect(service.create(PROVIDER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.listing.create).not.toHaveBeenCalled();
    });

    it('omits null and empty string values when creating a draft', async () => {
      const listing = makeRawListing({
        city: null,
        zip: null,
        objectType: null,
        title: 'Draft title',
        shortDescription: null,
        petsPolicy: null,
      });
      const dto: CreateListingDto = {
        title: 'Draft title',
        zip: '',
        shortDescription: '',
        petsPolicy: null,
      };
      prismaMock.listing.create.mockResolvedValue(listing);

      await service.create(PROVIDER_ID, dto);

      const listingCreateArgs = prismaMock.listing.create.mock
        .calls[0][0] as ListingCreateArgs;

      expect(listingCreateArgs.data).toEqual({
        providerId: PROVIDER_ID,
        title: 'Draft title',
      });
    });

    it('allows a file-only draft', async () => {
      const uploadResult = makeUploadResult();
      const listing = makeRawListing({
        id: LISTING_ID,
        city: null,
        zip: null,
        objectType: null,
        photos: [uploadResult.secure_url],
      });
      const image = makeRawListingImage({
        listingId: LISTING_ID,
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
      });

      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      prismaMock.listing.create.mockResolvedValue(listing);
      prismaMock.listingImage.create.mockResolvedValue(image);

      const result = await service.create(PROVIDER_ID, {}, makeMulterFile());

      expect(cloudinaryMock.uploadBuffer).toHaveBeenCalled();
      expect(result).toEqual(listing);
    });

    it('creates a listing and first image metadata when a file is provided', async () => {
      const uploadResult = makeUploadResult();
      const listing = makeRawListing({
        id: LISTING_ID,
        photos: [uploadResult.secure_url],
      });
      const image = makeRawListingImage({
        listingId: LISTING_ID,
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
      });
      const dto: CreateListingDto = {
        objectType: ObjectType.APARTMENT,
        city: 'Berlin',
        zip: '10115',
      };

      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      prismaMock.listing.create.mockResolvedValue(listing);
      prismaMock.listingImage.create.mockResolvedValue(image);

      const result = await service.create(PROVIDER_ID, dto, makeMulterFile());
      const listingCreateArgs = prismaMock.listing.create.mock
        .calls[0][0] as ListingCreateArgs;
      const imageCreateArgs = prismaMock.listingImage.create.mock
        .calls[0][0] as ListingImageCreateArgs;

      expect(cloudinaryMock.uploadBuffer).toHaveBeenCalledWith(
        expect.any(Buffer),
        `${CLOUDINARY_FOLDER}/listings/${listingCreateArgs.data.id}`,
      );
      expect(listingCreateArgs.data).toEqual(
        expect.objectContaining({
          providerId: PROVIDER_ID,
          city: 'Berlin',
          zip: '10115',
          photos: [uploadResult.secure_url],
        }),
      );
      expect(imageCreateArgs.data).toEqual({
        listingId: listingCreateArgs.data.id,
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
        position: 0,
        isCover: true,
      });
      expect(result).toEqual(listing);
    });

    it('deletes the uploaded image when database creation fails', async () => {
      const uploadResult = makeUploadResult();
      const dbError = new Error('database failed');
      const dto: CreateListingDto = {
        objectType: ObjectType.APARTMENT,
        city: 'Berlin',
        zip: '10115',
      };

      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      cloudinaryMock.deleteByPublicId.mockResolvedValue(undefined);
      prismaMock.listing.create.mockRejectedValue(dbError);

      await expect(
        service.create(PROVIDER_ID, dto, makeMulterFile()),
      ).rejects.toThrow(dbError);

      expect(cloudinaryMock.deleteByPublicId).toHaveBeenCalledWith(
        uploadResult.public_id,
      );
    });
  });

  describe('update', () => {
    it('recalculates deposit when cold rent changes', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      const updated = makeRawListing({
        coldRent: 1300,
        deposit: 2600,
        depositMonths: 2,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      const result = await service.update(LISTING_ID, PROVIDER_ID, {
        coldRent: 1300,
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          coldRent: 1300,
          deposit: 2600,
          depositMonths: 2,
        }),
      );
      expect(result).toEqual(updated);
    });

    it('recalculates deposit when deposit months change', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      const updated = makeRawListing({
        coldRent: 1000,
        deposit: 3000,
        depositMonths: 3,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      await service.update(LISTING_ID, PROVIDER_ID, { depositMonths: 3 });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          deposit: 3000,
          depositMonths: 3,
        }),
      );
    });

    it('stores deposit months without requiring cold rent on a draft', async () => {
      const listing = makeRawListing({ coldRent: null, depositMonths: 2 });
      const updated = makeRawListing({ coldRent: null, depositMonths: 1 });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      await service.update(LISTING_ID, PROVIDER_ID, { depositMonths: 1 });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual({ depositMonths: 1 });
    });

    it('keeps existing eligibility criteria when they are omitted', async () => {
      const listing = makeRawListing({
        minimumHouseholdNetIncome: 3000,
        suitableForPeopleCount: 2,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(
        makeRawListing({
          minimumHouseholdNetIncome: 3000,
          suitableForPeopleCount: 2,
          title: 'Updated title',
        }),
      );

      await service.update(LISTING_ID, PROVIDER_ID, { title: 'Updated title' });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual({ title: 'Updated title' });
    });

    it('clears explicitly unselected eligibility criteria', async () => {
      const listing = makeRawListing({
        minimumHouseholdNetIncome: 3000,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: 2,
        petsPolicy: PetsPolicy.ALLOWED,
        smokingPolicy: SmokingPolicy.ALLOWED,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(
        makeRawListing({
          minimumHouseholdNetIncome: null,
          schufaRequired: false,
          incomeProofRequired: false,
          suitableForPeopleCount: null,
          petsPolicy: null,
          smokingPolicy: null,
        }),
      );

      await service.update(LISTING_ID, PROVIDER_ID, {
        minimumHouseholdNetIncome: null,
        schufaRequired: false,
        incomeProofRequired: false,
        suitableForPeopleCount: null,
        petsPolicy: null,
        smokingPolicy: null,
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;
      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          minimumHouseholdNetIncome: null,
          schufaRequired: false,
          incomeProofRequired: false,
          suitableForPeopleCount: null,
          petsPolicy: null,
          smokingPolicy: null,
        }),
      );
    });

    it('rejects mismatched deposit on update', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.update(LISTING_ID, PROVIDER_ID, { deposit: 3000 }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it('rejects bedrooms greater than rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.update(LISTING_ID, PROVIDER_ID, { rooms: 2, bedrooms: 5 }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it('allows bedrooms equal to rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue({
        ...listing,
        rooms: 3,
        bedrooms: 3,
      });

      await expect(
        service.update(LISTING_ID, PROVIDER_ID, { rooms: 3, bedrooms: 3 }),
      ).resolves.toBeDefined();
      expect(prismaMock.listing.update).toHaveBeenCalled();
    });

    it('allows bedrooms less than rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue({
        ...listing,
        rooms: 4,
        bedrooms: 2,
      });

      await expect(
        service.update(LISTING_ID, PROVIDER_ID, { rooms: 4, bedrooms: 2 }),
      ).resolves.toBeDefined();
    });
  });

  describe('findAllByProvider', () => {
    it('returns all listings for a provider ordered by createdAt desc with ACTIVE application counts', async () => {
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
          orderBy: { createdAt: 'desc' },
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

  describe('findPublishedForApplicant', () => {
    const discoveryListing = makeDiscoveryListing();

    it('returns only PUBLISHED listings with publishedAt', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
            ]),
          },
        }),
      );
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      expect(result).toHaveProperty('total');
      expect(result.items).toHaveLength(0);
    });

    it('returns summaries with cover image', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(LISTING_ID);
      expect(result.items[0].title).toBe('Test Listing');
      expect(result.items[0].coverImage).toEqual({
        secureUrl: 'https://example.com/cover.jpg',
      });
    });

    it('handles null coverImage when no images exist', async () => {
      const noImage = makeDiscoveryListing({
        images: [],
      });
      prismaMock.listing.findMany.mockResolvedValue([noImage]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items[0].coverImage).toBeNull();
    });

    it('applies city filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({ city: 'Berlin' }, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { city: { equals: 'Berlin', mode: 'insensitive' } },
            ]),
          },
        }),
      );
    });

    it('applies rent range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { minRent: 500, maxRent: 2000 },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { coldRent: { gte: 500, lte: 2000 } },
            ]),
          },
        }),
      );
    });

    it('applies rooms range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        {
          minRooms: 1,
          maxRooms: 4,
        },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { rooms: { gte: 1, lte: 4 } },
            ]),
          },
        }),
      );
    });

    it('applies living area range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        {
          minLivingArea: 20,
          maxLivingArea: 100,
        },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { livingArea: { gte: 20, lte: 100 } },
            ]),
          },
        }),
      );
    });

    it('returns null nextCursor when there are no more pages', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant(
        { limit: 50 },
        null,
      );

      expect(result.nextCursor).toBeNull();
    });

    it('returns nextCursor when there is a next page', async () => {
      const pageItems = Array.from({ length: 6 }, (_, i) =>
        makeDiscoveryListing({
          id: `00000000-0000-4000-8000-00000000000${i}`,
          publishedAt: new Date(2026, 6, 1 + i),
        }),
      );
      prismaMock.listing.findMany.mockResolvedValue(pageItems);

      const result = await service.findPublishedForApplicant(
        { limit: 5 },
        null,
      );

      expect(result.items).toHaveLength(5);
      expect(result.nextCursor).not.toBeNull();
      expect(typeof result.nextCursor).toBe('string');
    });

    it('rejects invalid cursor', async () => {
      await expect(
        service.findPublishedForApplicant({ cursor: 'not-valid-base64' }, null),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns empty page for no results', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('excludes private fields from summaries', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      const summary = serialized(result.items[0]);
      expect(summary).not.toHaveProperty('providerId');
      expect(summary).not.toHaveProperty('minimumHouseholdNetIncome');
      expect(summary).not.toHaveProperty('schufaRequired');
      expect(summary).not.toHaveProperty('showExactAddress');
    });

    it('applicant with incomplete profile returns PROFILE_INCOMPLETE', async () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeApplicantProfile(),
      );
      eligibilityMock.isProfileComplete.mockReturnValue(false);
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(
        ProfileMatch.PROFILE_INCOMPLETE,
      );
    });

    it('applicant with complete profile + eligible returns MATCH', async () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeApplicantProfile(),
      );
      eligibilityMock.isProfileComplete.mockReturnValue(true);
      eligibilityMock.evaluateCriteria.mockReturnValue({
        canApply: true,
        reasons: [],
        warnings: [],
        evaluatedAt: new Date(),
      });
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.MATCH);
    });

    it('applicant with complete profile + not eligible returns NO_MATCH', async () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeApplicantProfile(),
      );
      eligibilityMock.isProfileComplete.mockReturnValue(true);
      eligibilityMock.evaluateCriteria.mockReturnValue({
        canApply: false,
        reasons: [],
        warnings: [],
        evaluatedAt: new Date(),
      });
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.NO_MATCH);
    });

    it('null user returns UNKNOWN', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
    });

    it('provider user returns UNKNOWN', async () => {
      const providerUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.PROVIDER,
        providerType: PublicProviderType.PRIVATE,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, providerUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
    });

    it('non-ACTIVE applicant returns UNKNOWN without profile lookup', async () => {
      const suspendedUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.SUSPENDED,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.listing.count.mockResolvedValue(1);
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, suspendedUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
      expect(prismaMock.applicantProfile.findUnique).not.toHaveBeenCalled();
    });

    it('sets cache-control headers on the response', async () => {
      const res = { setHeader: jest.fn() };
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({}, null, res);

      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store, must-revalidate',
      );
    });

    it('throws BadRequestException when cursor sort does not match', async () => {
      const payload = {
        sort: 'newest',
        publishedAt: '2026-07-01T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000001',
      };
      const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url');

      await expect(
        service.findPublishedForApplicant({ cursor, sort: 'price-asc' }, null),
      ).rejects.toThrow(BadRequestException);
    });

    it('applies free-text query search across title, city, zip and district', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({ query: 'Berlin' }, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              {
                OR: [
                  {
                    title: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    city: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    zip: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    district: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                ],
              },
            ]),
          },
        }),
      );
    });

    it('applies availableBy filter with Berlin midnight', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { availableBy: '2026-08-01' },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { availableFrom: { not: null } },
              {
                availableFrom: {
                  lt: new Date('2026-08-01T22:00:00.000Z'),
                },
              },
            ]),
          },
        }),
      );
    });

    it('applies petsPolicy filter', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { petsPolicy: PetsPolicy.ALLOWED },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { petsPolicy: PetsPolicy.ALLOWED },
            ]),
          },
        }),
      );
    });
  });

  describe('findPublishedDetailForApplicant', () => {
    const discoveryDetail = makeDiscoveryDetail();

    it('returns a published listing detail', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.id).toBe(LISTING_ID);
      expect(result.title).toBe('Test Listing');
    });

    it('hides street when showExactAddress is false', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeDiscoveryDetail({
          showExactAddress: false,
          street: 'Hauptstrasse 1',
        }),
      );

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.street).toBeNull();
    });

    it('shows street when showExactAddress is true', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeDiscoveryDetail({
          showExactAddress: true,
          street: 'Hauptstrasse 1',
        }),
      );

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.street).toBe('Hauptstrasse 1');
    });

    it('includes public application requirements', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.requirements.minimumHouseholdNetIncome).toBe(3000);
      expect(result.requirements.schufaRequired).toBe(true);
      expect(result.requirements.incomeProofRequired).toBe(false);
      expect(result.requirements.suitableForPeopleCount).toBe(2);
    });

    it('returns 404 for non-published listing', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findPublishedDetailForApplicant(LISTING_ID, null),
      ).rejects.toThrow(NotFoundException);
    });

    it('never exposes showExactAddress flag', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      expect(serialized_).not.toHaveProperty('showExactAddress');
    });

    it('never exposes providerId', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      expect(serialized_).not.toHaveProperty('providerId');
    });

    it('includes images without publicId', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      const images = serialized_.images as Record<string, unknown>[];
      for (const image of images) {
        expect(image).not.toHaveProperty('publicId');
        expect(image.secureUrl).toBeDefined();
      }
    });

    describe('profile match', () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      const providerUser: SafeUser = {
        ...applicantUser,
        id: '00000000-0000-4000-8000-000000000098',
        role: Role.PROVIDER,
        providerType: PublicProviderType.PRIVATE,
      };

      it('null user returns UNKNOWN', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          null,
        );

        expect(result.profileMatch).toBe(ProfileMatch.UNKNOWN);
      });

      it('provider user returns UNKNOWN', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          providerUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.UNKNOWN);
      });

      it('applicant with incomplete profile returns PROFILE_INCOMPLETE', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(false);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.PROFILE_INCOMPLETE);
      });

      it('applicant with complete profile returns MATCH when eligible', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(true);
        eligibilityMock.evaluateCriteria.mockReturnValue({
          canApply: true,
          reasons: [],
          warnings: [],
          evaluatedAt: new Date(),
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.MATCH);
      });

      it('applicant with complete profile returns NO_MATCH when ineligible', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(true);
        eligibilityMock.evaluateCriteria.mockReturnValue({
          canApply: false,
          reasons: [],
          warnings: [],
          evaluatedAt: new Date(),
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.NO_MATCH);
      });
    });
  });
});
