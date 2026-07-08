import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import { CloudinaryService } from './cloudinary.service';

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

const LISTING_ID = '00000000-0000-4000-8000-000000000001';
const FOLDER = `renyqo/listings/${LISTING_ID}`;

const makeConfigService = (
  overrides: Partial<Record<string, string | undefined>> = {},
) => ({
  get: jest.fn((key: string) => {
    const map: Record<string, string | undefined> = {
      CLOUDINARY_CLOUD_NAME: 'test-cloud',
      CLOUDINARY_API_KEY: 'test-key',
      CLOUDINARY_API_SECRET: 'test-secret',
      ...overrides,
    };
    return map[key];
  }),
});

describe('CloudinaryService', () => {
  let service: CloudinaryService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudinaryService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get<CloudinaryService>(CloudinaryService);
  });

  describe('uploadBuffer', () => {
    it('rejects with ServiceUnavailableException when Cloudinary credentials are missing', async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CloudinaryService,
          {
            provide: ConfigService,
            useValue: makeConfigService({
              CLOUDINARY_CLOUD_NAME: undefined,
              CLOUDINARY_API_KEY: undefined,
              CLOUDINARY_API_SECRET: undefined,
            }),
          },
        ],
      }).compile();

      const unconfiguredService =
        module.get<CloudinaryService>(CloudinaryService);

      await expect(
        unconfiguredService.uploadBuffer(Buffer.from('fake'), FOLDER),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(cloudinary.config).not.toHaveBeenCalled();
      expect(cloudinary.uploader.upload_stream).not.toHaveBeenCalled();
    });

    it('resolves with the UploadApiResponse on success', async () => {
      const fakeResult = {
        public_id: `${FOLDER}/abc123`,
        secure_url: 'https://res.cloudinary.com/test/image/upload/abc123.jpg',
      } as UploadApiResponse;

      const mockStream = { end: jest.fn() };
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const cb = args[1] as
            | ((err: null, result: typeof fakeResult) => void)
            | undefined;
          cb?.(null, fakeResult);
          return mockStream;
        },
      );

      const buffer = Buffer.from('fake-image-data');
      const result = await service.uploadBuffer(buffer, FOLDER);

      expect(result).toEqual(fakeResult);
      expect(mockStream.end).toHaveBeenCalledWith(buffer);
    });

    it('rejects when Cloudinary returns an error', async () => {
      const error = { message: 'Upload failed', http_code: 401 };
      const mockStream = { end: jest.fn() };
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (...args: unknown[]) => {
          const cb = args[1] as
            | ((err: typeof error, result: null) => void)
            | undefined;
          cb?.(error, null);
          return mockStream;
        },
      );

      await expect(
        service.uploadBuffer(Buffer.from('fake'), FOLDER),
      ).rejects.toMatchObject({ message: 'Upload failed' });
    });
  });

  describe('deleteByPublicId', () => {
    it('calls cloudinary.uploader.destroy with publicId and image resource_type', async () => {
      (cloudinary.uploader.destroy as jest.Mock).mockImplementation(() =>
        Promise.resolve({ result: 'ok' }),
      );

      await service.deleteByPublicId(`${FOLDER}/abc123`);

      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
        `${FOLDER}/abc123`,
        { resource_type: 'image' },
      );
    });
  });
});
