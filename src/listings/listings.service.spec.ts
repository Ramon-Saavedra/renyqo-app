import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UploadApiResponse } from 'cloudinary';

import type { Listing, ListingImage } from '../generated/prisma/client';
import {
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import type { CreateListingDto } from './dto/create-listing.dto';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const LISTING_ID_2 = '00000000-0000-4000-8000-000000000003';
const OTHER_LISTING_ID = '00000000-0000-4000-8000-000000000004';
const CLOUDINARY_FOLDER = 'renyqo';

type ListingsTransactionMock = {
  listing: {
    create: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<Listing[]>>;
    findFirst: jest.MockedFunction<(args?: unknown) => Promise<Listing | null>>;
    update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
  };
  listingImage: {
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
  };
};

type PrismaTransactionRunner = (
  fn: (tx: ListingsTransactionMock) => Promise<unknown>,
) => Promise<unknown>;

type PrismaMock = ListingsTransactionMock & {
  $transaction: jest.MockedFunction<PrismaTransactionRunner>;
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

const makeMulterFile = (): Express.Multer.File => ({
  fieldname: 'file',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  buffer: Buffer.from('fake-image'),
  size: 10,
  stream: null as never,
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
  let cloudinaryMock: jest.Mocked<CloudinaryService>;

  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = async (fn) =>
      fn(prismaMock);

    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<Listing[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest.fn<(args?: unknown) => Promise<number>>(),
      },
      listingImage: {
        create: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
      },
      $transaction: jest.fn<PrismaTransactionRunner>(transactionRunner),
    };

    cloudinaryMock = {
      uploadBuffer:
        jest.fn<
          (buffer: Buffer, folder: string) => Promise<UploadApiResponse>
        >(),
      deleteByPublicId: jest.fn<(publicId: string) => Promise<void>>(),
    } as unknown as jest.Mocked<CloudinaryService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CloudinaryService, useValue: cloudinaryMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
        },
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
      });
      const dto = {
        title: 'Draft title',
        city: null,
        zip: '',
        shortDescription: '',
      } as unknown as CreateListingDto;
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
  });

  describe('findAllByProvider', () => {
    it('returns all listings for a provider ordered by createdAt desc', async () => {
      const listings = [makeRawListing(), makeRawListing({ id: LISTING_ID_2 })];
      prismaMock.listing.findMany.mockResolvedValue(listings);

      const result = await service.findAllByProvider(PROVIDER_ID);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: PROVIDER_ID },
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

  describe('toListingResponse', () => {
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
