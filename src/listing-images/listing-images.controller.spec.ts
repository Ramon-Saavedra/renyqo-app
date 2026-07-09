import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';
import type { ListingImage } from '../generated/prisma/client';
import { Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';
import { ListingImagesController } from './listing-images.controller';
import { ListingImagesService } from './listing-images.service';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const IMAGE_ID = '00000000-0000-4000-8000-000000000003';

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

const makeReq = (): Request =>
  ({ user: makeProviderUser() }) as unknown as Request;

const makeFile = (): Express.Multer.File => ({
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

const makeListingImage = (): ListingImage => ({
  id: IMAGE_ID,
  listingId: LISTING_ID,
  publicId: 'renyqo/listings/abc/xyz',
  secureUrl: 'https://res.cloudinary.com/test/image/upload/xyz.jpg',
  position: 0,
  isCover: true,
  createdAt: new Date('2024-01-01'),
});

const makeListingImageResponse = (): ListingImageResponseDto =>
  ListingImageResponseDto.fromListingImage(makeListingImage());

describe('ListingImagesController', () => {
  let controller: ListingImagesController;
  let listingImagesService: jest.Mocked<ListingImagesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ListingImagesController],
      providers: [
        {
          provide: ListingImagesService,
          useValue: {
            upload: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ListingImagesController>(ListingImagesController);
    listingImagesService = module.get(ListingImagesService);
  });

  describe('uploadImage', () => {
    it('calls listingImagesService.upload with listing id, provider id and file', async () => {
      const image = makeListingImageResponse();
      const file = makeFile();
      listingImagesService.upload.mockResolvedValue(image);

      const result = await controller.uploadImage(
        { listingId: LISTING_ID },
        file,
        makeReq(),
      );

      expect(listingImagesService.upload).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
        file,
      );
      expect(result).toEqual(image);
    });

    it('returns the stored ListingImage from the service', async () => {
      const image = makeListingImageResponse();
      listingImagesService.upload.mockResolvedValue(image);

      const result = await controller.uploadImage(
        { listingId: LISTING_ID },
        makeFile(),
        makeReq(),
      );

      expect(result.isCover).toBe(true);
      expect(result.position).toBe(0);
      expect(result.secureUrl).toBe(image.secureUrl);
    });
  });
});
