import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE } from './listing-image-upload.constants';

@Catch(PayloadTooLargeException)
export class ListingImageUploadExceptionFilter implements ExceptionFilter<PayloadTooLargeException> {
  catch(exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = exception.getStatus();

    response.status(statusCode).json({
      statusCode,
      message: LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE,
    });
  }
}
