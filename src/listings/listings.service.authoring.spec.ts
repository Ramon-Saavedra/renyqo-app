import { BadRequestException } from '@nestjs/common';
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
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';
import type { CreateListingDto } from './dto/create-listing.dto';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
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

type ListingUploadFile = NonNullable<Parameters<ListingsService['create']>[2]>;

const makeMulterFile = (): ListingUploadFile => ({
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
      expect(prismaMock.$transaction).toHaveBeenCalled();
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
        displayOrder: 1,
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
});
