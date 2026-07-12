import {
  Controller,
  Param,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ListingImageParamsDto } from './dto/listing-image-params.dto';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';
import { ListingImageUploadExceptionFilter } from './listing-image-upload-exception.filter';
import {
  LISTING_IMAGE_FILE_FIELD,
  LISTING_IMAGE_MULTER_OPTIONS,
  REQUIRED_LISTING_IMAGE_FILE_PIPE,
} from './listing-image-upload.constants';
import { ListingImagesService } from './listing-images.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@UseFilters(ListingImageUploadExceptionFilter)
@Controller('provider/listings')
export class ListingImagesController {
  constructor(private readonly listingImagesService: ListingImagesService) {}

  @Post(':listingId/images')
  @UseInterceptors(
    FileInterceptor(LISTING_IMAGE_FILE_FIELD, LISTING_IMAGE_MULTER_OPTIONS),
  )
  uploadImage(
    @Param() params: ListingImageParamsDto,
    @UploadedFile(REQUIRED_LISTING_IMAGE_FILE_PIPE) file: Express.Multer.File,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingImageResponseDto> {
    return this.listingImagesService.upload(params.listingId, user.id, file);
  }
}
