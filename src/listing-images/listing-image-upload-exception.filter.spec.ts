import { ArgumentsHost, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';
import { ListingImageUploadExceptionFilter } from './listing-image-upload-exception.filter';
import { LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE } from './listing-image-upload.constants';

describe('ListingImageUploadExceptionFilter', () => {
  it('returns a clean German message for oversized uploads', () => {
    const filter = new ListingImageUploadExceptionFilter();
    const json = jest.fn();
    const response = {
      status: jest.fn(() => ({ json })),
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
      }),
    } as ArgumentsHost;

    filter.catch(new PayloadTooLargeException('File too large'), host);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      message: LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE,
    });
  });
});
