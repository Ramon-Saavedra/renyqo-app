import {
  Controller,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ListingImageParamsDto } from './dto/listing-image-params.dto';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';
import {
  LISTING_IMAGE_FILE_FIELD,
  MAX_LISTING_IMAGE_FILE_SIZE_BYTES,
  REQUIRED_LISTING_IMAGE_FILE_PIPE,
} from './listing-image-upload.constants';
import { ListingImagesService } from './listing-images.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/listings')
export class ListingImagesController {
  constructor(private readonly listingImagesService: ListingImagesService) {}

  @Post(':listingId/images')
  @UseInterceptors(
    FileInterceptor(LISTING_IMAGE_FILE_FIELD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_LISTING_IMAGE_FILE_SIZE_BYTES, files: 1 },
    }),
  )
  uploadImage(
    @Param() params: ListingImageParamsDto,
    @UploadedFile(REQUIRED_LISTING_IMAGE_FILE_PIPE) file: Express.Multer.File,
    @Req() req: Request,
  ): Promise<ListingImageResponseDto> {
    const user = req.user as SafeUser;
    return this.listingImagesService.upload(params.listingId, user.id, file);
  }
}
