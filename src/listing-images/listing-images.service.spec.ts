import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
      (args?: unknown) => Promise<Partial<ListingImage> | null>
    >;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<ListingImage[]>>;
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
    update: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
    deleteMany: jest.MockedFunction<
      (args?: unknown) => Promise<{ count: number }>
    >;
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
          jest.fn<(args?: unknown) => Promise<Partial<ListingImage> | null>>(),
        findMany: jest.fn<(args?: unknown) => Promise<ListingImage[]>>(),
        create: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
        update: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
        deleteMany: jest.fn<(args?: unknown) => Promise<{ count: number }>>(),
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

  describe('findAllByListing', () => {
    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findAllByListing(LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);

      expect(prismaMock.listingImage.findMany).not.toHaveBeenCalled();
    });

    it('returns images ordered by position with public metadata only', async () => {
      const cover = makeListingImage();
      const second = makeListingImage({
        id: '00000000-0000-4000-8000-000000000004',
        publicId: `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/def`,
        secureUrl: 'https://res.cloudinary.com/test/image/upload/def.jpg',
        position: 1,
        isCover: false,
      });
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findMany.mockResolvedValue([cover, second]);

      const result = await service.findAllByListing(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.listingImage.findMany).toHaveBeenCalledWith({
        where: { listingId: LISTING_ID },
        orderBy: { position: 'asc' },
      });
      expect(result).toEqual([
        {
          id: cover.id,
          secureUrl: cover.secureUrl,
          position: 0,
          isCover: true,
        },
        {
          id: second.id,
          secureUrl: second.secureUrl,
          position: 1,
          isCover: false,
        },
      ]);
    });
  });

  describe('remove', () => {
    const SECOND_IMAGE_ID = '00000000-0000-4000-8000-000000000004';
    const THIRD_IMAGE_ID = '00000000-0000-4000-8000-000000000005';

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);

      expect(cloudinaryMock.deleteByPublicId).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the image does not belong to the listing', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue(null);

      await expect(
        service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);

      expect(cloudinaryMock.deleteByPublicId).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('keeps the Cloudinary asset when the database mutation fails', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        publicId: `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`,
      });
      prismaMock.listingImage.deleteMany.mockRejectedValue(
        new Error('database unavailable'),
      );

      await expect(
        service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID),
      ).rejects.toThrow('database unavailable');

      expect(cloudinaryMock.deleteByPublicId).not.toHaveBeenCalled();
    });

    it('still removes the image when the Cloudinary delete fails after the transaction', async () => {
      const publicId = `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`;
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        publicId,
      });
      prismaMock.listingImage.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.listingImage.findMany.mockResolvedValue([]);
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });
      cloudinaryMock.deleteByPublicId.mockRejectedValue(
        new Error('cloudinary unavailable'),
      );

      await expect(
        service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID),
      ).resolves.toBeUndefined();

      expect(prismaMock.listingImage.deleteMany).toHaveBeenCalledWith({
        where: { id: IMAGE_ID },
      });
      expect(cloudinaryMock.deleteByPublicId).toHaveBeenCalledWith(publicId);
    });

    it('deletes the asset, compacts positions, promotes the cover and syncs photos', async () => {
      const publicId = `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`;
      const second = makeListingImage({
        id: SECOND_IMAGE_ID,
        secureUrl: 'https://res.cloudinary.com/test/image/upload/def.jpg',
        position: 1,
        isCover: false,
      });
      const third = makeListingImage({
        id: THIRD_IMAGE_ID,
        secureUrl: 'https://res.cloudinary.com/test/image/upload/ghi.jpg',
        position: 2,
        isCover: false,
      });

      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        publicId,
      });
      cloudinaryMock.deleteByPublicId.mockResolvedValue(undefined);
      prismaMock.listingImage.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.listingImage.findMany.mockResolvedValue([second, third]);
      prismaMock.listingImage.update.mockResolvedValue(second);
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });

      await service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID);

      expect(cloudinaryMock.deleteByPublicId).toHaveBeenCalledWith(publicId);
      expect(prismaMock.listingImage.deleteMany).toHaveBeenCalledWith({
        where: { id: IMAGE_ID },
      });
      expect(
        prismaMock.listingImage.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        cloudinaryMock.deleteByPublicId.mock.invocationCallOrder[0],
      );
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(1, {
        where: { id: SECOND_IMAGE_ID },
        data: { position: -1 },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(2, {
        where: { id: THIRD_IMAGE_ID },
        data: { position: -2 },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(3, {
        where: { id: SECOND_IMAGE_ID },
        data: { position: 0, isCover: true },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(4, {
        where: { id: THIRD_IMAGE_ID },
        data: { position: 1, isCover: false },
      });
      expect(prismaMock.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { photos: [second.secureUrl, third.secureUrl] },
      });
    });

    it('clears photos when the last image is removed', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findFirst.mockResolvedValue({
        id: IMAGE_ID,
        publicId: `${CLOUDINARY_FOLDER}/listings/${LISTING_ID}/abc`,
      });
      cloudinaryMock.deleteByPublicId.mockResolvedValue(undefined);
      prismaMock.listingImage.deleteMany.mockResolvedValue({ count: 1 });
      prismaMock.listingImage.findMany.mockResolvedValue([]);
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });

      await service.remove(LISTING_ID, IMAGE_ID, PROVIDER_ID);

      expect(prismaMock.listingImage.update).not.toHaveBeenCalled();
      expect(prismaMock.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { photos: [] },
      });
    });
  });

  describe('reorder', () => {
    const SECOND_IMAGE_ID = '00000000-0000-4000-8000-000000000004';
    const FOREIGN_IMAGE_ID = '00000000-0000-4000-8000-000000000099';

    const makeImagePair = (): ListingImage[] => [
      makeListingImage(),
      makeListingImage({
        id: SECOND_IMAGE_ID,
        secureUrl: 'https://res.cloudinary.com/test/image/upload/def.jpg',
        position: 1,
        isCover: false,
      }),
    ];

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.reorder(LISTING_ID, PROVIDER_ID, {
          imageIds: [IMAGE_ID, SECOND_IMAGE_ID],
        }),
      ).rejects.toThrow(NotFoundException);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rejects duplicated image ids', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findMany.mockResolvedValue(makeImagePair());

      await expect(
        service.reorder(LISTING_ID, PROVIDER_ID, {
          imageIds: [IMAGE_ID, IMAGE_ID],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.listingImage.update).not.toHaveBeenCalled();
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it('rejects an incomplete image id set', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findMany.mockResolvedValue(makeImagePair());

      await expect(
        service.reorder(LISTING_ID, PROVIDER_ID, { imageIds: [IMAGE_ID] }),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.listingImage.update).not.toHaveBeenCalled();
    });

    it('rejects image ids that belong to another listing', async () => {
      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findMany.mockResolvedValue(makeImagePair());

      await expect(
        service.reorder(LISTING_ID, PROVIDER_ID, {
          imageIds: [IMAGE_ID, FOREIGN_IMAGE_ID],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prismaMock.listingImage.update).not.toHaveBeenCalled();
    });

    it('reorders in two phases, promotes the new cover and syncs photos', async () => {
      const [cover, second] = makeImagePair();
      const reorderedRecords = [
        makeListingImage({
          id: SECOND_IMAGE_ID,
          secureUrl: second.secureUrl,
          position: 0,
          isCover: true,
        }),
        makeListingImage({ position: 1, isCover: false }),
      ];

      prismaMock.listing.findFirst.mockResolvedValue({ id: LISTING_ID });
      prismaMock.listingImage.findMany
        .mockResolvedValueOnce([cover, second])
        .mockResolvedValueOnce(reorderedRecords);
      prismaMock.listingImage.update.mockResolvedValue(cover);
      prismaMock.listing.update.mockResolvedValue({ id: LISTING_ID });

      const result = await service.reorder(LISTING_ID, PROVIDER_ID, {
        imageIds: [SECOND_IMAGE_ID, IMAGE_ID],
      });

      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(1, {
        where: { id: SECOND_IMAGE_ID },
        data: { position: -1 },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(2, {
        where: { id: IMAGE_ID },
        data: { position: -2 },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(3, {
        where: { id: SECOND_IMAGE_ID },
        data: { position: 0, isCover: true },
      });
      expect(prismaMock.listingImage.update).toHaveBeenNthCalledWith(4, {
        where: { id: IMAGE_ID },
        data: { position: 1, isCover: false },
      });
      expect(prismaMock.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { photos: [second.secureUrl, cover.secureUrl] },
      });
      expect(result).toEqual([
        {
          id: SECOND_IMAGE_ID,
          secureUrl: second.secureUrl,
          position: 0,
          isCover: true,
        },
        {
          id: IMAGE_ID,
          secureUrl: cover.secureUrl,
          position: 1,
          isCover: false,
        },
      ]);
    });
  });
});
