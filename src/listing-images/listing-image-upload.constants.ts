import { HttpStatus, ParseFilePipeBuilder } from '@nestjs/common';

export const LISTING_IMAGE_FILE_FIELD = 'file';
export const MAX_LISTING_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const buildListingImageFilePipe = (fileIsRequired: boolean) =>
  new ParseFilePipeBuilder()
    .addMaxSizeValidator({ maxSize: MAX_LISTING_IMAGE_FILE_SIZE_BYTES })
    .addFileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ })
    .build({
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      fileIsRequired,
    });

export const REQUIRED_LISTING_IMAGE_FILE_PIPE = buildListingImageFilePipe(true);

export const OPTIONAL_LISTING_IMAGE_FILE_PIPE =
  buildListingImageFilePipe(false);
