import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import {
  LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE,
  LISTING_IMAGE_INVALID_FILE_TYPE_MESSAGE,
  LISTING_IMAGE_MULTER_OPTIONS,
  MAX_LISTING_IMAGE_FILE_SIZE_BYTES,
  OPTIONAL_LISTING_IMAGE_FILE_PIPE,
  REQUIRED_LISTING_IMAGE_FILE_PIPE,
} from './listing-image-upload.constants';

const makeFile = (
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File => ({
  fieldname: 'file',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
  size: 1024,
  stream: null as never,
  destination: '',
  filename: '',
  path: '',
  ...overrides,
});

const getExceptionMessage = (error: unknown): string | undefined => {
  if (!(error instanceof BadRequestException)) {
    return undefined;
  }

  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }

  if (
    typeof response === 'object' &&
    response !== null &&
    'message' in response
  ) {
    const message = response.message;
    return typeof message === 'string' ? message : undefined;
  }

  return undefined;
};

describe('listing image upload constants', () => {
  it('allows jpg/jpeg, png and webp mime types in Multer', () => {
    const fileFilter = LISTING_IMAGE_MULTER_OPTIONS.fileFilter;
    expect(fileFilter).toBeDefined();

    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      const callback = jest.fn();

      fileFilter?.({}, makeFile({ mimetype }), callback);

      expect(callback).toHaveBeenCalledWith(null, true);
    }
  });

  it('rejects unsupported mime types before upload handling', () => {
    const fileFilter = LISTING_IMAGE_MULTER_OPTIONS.fileFilter;
    const callback = jest.fn();

    fileFilter?.({}, makeFile({ mimetype: 'application/pdf' }), callback);

    const [error, accepted] = callback.mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(BadRequestException);
    expect(getExceptionMessage(error)).toBe(
      LISTING_IMAGE_INVALID_FILE_TYPE_MESSAGE,
    );
    expect(accepted).toBe(false);
  });

  it('rejects files over ten megabytes with the configured message', async () => {
    try {
      await REQUIRED_LISTING_IMAGE_FILE_PIPE.transform(
        makeFile({ size: MAX_LISTING_IMAGE_FILE_SIZE_BYTES + 1 }),
      );
      throw new Error('Expected image upload pipe to reject a large file');
    } catch (error) {
      expect(getExceptionMessage(error)).toBe(
        LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE,
      );
    }
  });

  it('rejects invalid file types with the configured message', async () => {
    try {
      await REQUIRED_LISTING_IMAGE_FILE_PIPE.transform(
        makeFile({
          mimetype: 'application/pdf',
          originalname: 'document.pdf',
          buffer: Buffer.from('%PDF'),
        }),
      );
      throw new Error('Expected image upload pipe to reject an invalid file');
    } catch (error) {
      expect(getExceptionMessage(error)).toBe(
        LISTING_IMAGE_INVALID_FILE_TYPE_MESSAGE,
      );
    }
  });

  it('allows optional listing image uploads to omit the file', async () => {
    await expect(
      OPTIONAL_LISTING_IMAGE_FILE_PIPE.transform(undefined),
    ).resolves.toBeUndefined();
  });
});
