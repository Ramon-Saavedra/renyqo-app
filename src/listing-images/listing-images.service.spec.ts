import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { ListingImage } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from './cloudinary.service';
import { ListingImagesService } from './listing-images.service';
import type { UploadApiResponse } from 'cloudinary';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const IMAGE_ID = '00000000-0000-4000-8000-000000000003';
const CLOUDINARY_FOLDER = 'renyqo';

type LatestListingImagePosition = { position: number };
type OwnedListing = { id: string };

type ListingImageTransactionMock = {
  listing: {
    findFirst: jest.MockedFunction<
      (args?: unknown) => Promise<OwnedListing | null>
    >;
    update: jest.MockedFunction<(args?: unknown) => Promise<OwnedListing>>;
  };
  listingImage: {
    findFirst: jest.MockedFunction<
      (args?: unknown) => Promise<LatestListingImagePosition | null>
    >;
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
  };
};

type PrismaTransactionRunner = (
  fn: (tx: ListingImageTransactionMock) => Promise<unknown>,
) => Promise<unknown>;

type PrismaMock = ListingImageTransactionMock & {
  $transaction: jest.MockedFunction<PrismaTransactionRunner>;
};

const makeListingImage = (
  overrides: Partial<ListingImage> = {},
): ListingImage => ({
  id: IMAGE_ID,
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

const makeUploadResult = (
  publicId = `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`,
): UploadApiResponse =>
  ({
    public_id: publicId,
    secure_url: 'https://res.cloudinary.com/test/image/upload/abc.jpg',
  }) as UploadApiResponse;

describe('ListingImagesService', () => {
  let service: ListingImagesService;
  let prismaMock: PrismaMock;
  let cloudinaryMock: jest.Mocked<CloudinaryService>;

  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = async (fn) =>
      fn(prismaMock);

    prismaMock = {
      listing: {
        findFirst: jest.fn<(args?: unknown) => Promise<OwnedListing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<OwnedListing>>(),
      },
      listingImage: {
        findFirst:
          jest.fn<
            (args?: unknown) => Promise<LatestListingImagePosition | null>
          >(),
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
        ListingImagesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: CloudinaryService, useValue: cloudinaryMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
        },
      ],
    }).compile();

    service = module.get<ListingImagesService>(ListingImagesService);
  });

  describe('upload', () => {
    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.upload(LISTING_ID, PROVIDER_ID, makeMulterFile()),
      ).rejects.toThrow(NotFoundException);

      expect(cloudinaryMock.uploadBuffer).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('uploads to Cloudinary and stores the first image as cover', async () => {
      const uploadResult = makeUploadResult();
      const storedImage = makeListingImage({
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
      });

      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue(null);
      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      prismaMock.listingImage.create.mockResolvedValue(storedImage);

      const result = await service.upload(
        LISTING_ID,
        PROVIDER_ID,
        makeMulterFile(),
      );

      expect(cloudinaryMock.uploadBuffer).toHaveBeenCalledWith(
        expect.any(Buffer),
        `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}`,
      );
      expect(prismaMock.listingImage.findFirst).toHaveBeenCalledWith({
        where: { listingId: LISTING_ID },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      expect(prismaMock.listingImage.create).toHaveBeenCalledWith({
        data: {
          listingId: LISTING_ID,
          publicId: uploadResult.public_id,
          secureUrl: uploadResult.secure_url,
          position: 0,
          isCover: true,
        },
      });
      expect(prismaMock.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { photos: { push: uploadResult.secure_url } },
      });
      expect(result.isCover).toBe(true);
      expect(result.secureUrl).toBe(uploadResult.secure_url);
    });

    it('stores subsequent images without cover and with incremented position', async () => {
      const uploadResult = makeUploadResult(
        `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/def`,
      );
      const secondImage = makeListingImage({
        publicId: uploadResult.public_id,
        secureUrl: uploadResult.secure_url,
        position: 1,
        isCover: false,
      });

      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue({ position: 0 });
      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      prismaMock.listingImage.create.mockResolvedValue(secondImage);

      const result = await service.upload(
        LISTING_ID,
        PROVIDER_ID,
        makeMulterFile(),
      );

      expect(prismaMock.listingImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ position: 1, isCover: false }),
      });
      expect(result.isCover).toBe(false);
      expect(result.position).toBe(1);
    });

    it('deletes the uploaded Cloudinary asset when database create conflicts', async () => {
      const uploadResult = makeUploadResult();
      const prismaError = new PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: 'test',
        },
      );

      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue(null);
      cloudinaryMock.uploadBuffer.mockResolvedValue(uploadResult);
      cloudinaryMock.deleteByPublicId.mockResolvedValue(undefined);
      prismaMock.listingImage.create.mockRejectedValue(prismaError);

      await expect(
        service.upload(LISTING_ID, PROVIDER_ID, makeMulterFile()),
      ).rejects.toThrow(ConflictException);

      expect(cloudinaryMock.deleteByPublicId).toHaveBeenCalledWith(
        uploadResult.public_id,
      );
    });
  });
});
