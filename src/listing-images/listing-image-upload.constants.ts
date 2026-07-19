import {
  BadRequestException,
  HttpStatus,
  ParseFilePipeBuilder,
} from '@nestjs/common';
import { memoryStorage } from 'multer';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

export const LISTING_IMAGE_FILE_FIELD = 'file';
export const MAX_LISTING_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE =
  'Das Bild ist zu groß. Bitte lade ein Bild bis 10 MB hoch.';
export const LISTING_IMAGE_INVALID_FILE_TYPE_MESSAGE =
  'Bitte lade ein Bild im Format JPG, PNG oder WebP hoch.';
export const ALLOWED_LISTING_IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

export const LISTING_IMAGE_MULTER_OPTIONS: MulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_LISTING_IMAGE_FILE_SIZE_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!ALLOWED_LISTING_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      callback(
        new BadRequestException(LISTING_IMAGE_INVALID_FILE_TYPE_MESSAGE),
        false,
      );
      return;
    }

    callback(null, true);
  },
};

const buildListingImageFilePipe = (fileIsRequired: boolean) =>
  new ParseFilePipeBuilder()
    .addMaxSizeValidator({
      maxSize: MAX_LISTING_IMAGE_FILE_SIZE_BYTES,
      errorMessage: LISTING_IMAGE_FILE_TOO_LARGE_MESSAGE,
    })
    .build({
      errorHttpStatusCode: HttpStatus.BAD_REQUEST,
      fileIsRequired,
    });

export const REQUIRED_LISTING_IMAGE_FILE_PIPE = buildListingImageFilePipe(true);

export const OPTIONAL_LISTING_IMAGE_FILE_PIPE =
  buildListingImageFilePipe(false);
