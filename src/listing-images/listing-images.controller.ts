import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { ListingImageItemDto } from './dto/listing-image-item.dto';
import { ListingImageItemParamsDto } from './dto/listing-image-item-params.dto';
import { ListingImageParamsDto } from './dto/listing-image-params.dto';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';
import { ReorderListingImagesDto } from './dto/reorder-listing-images.dto';
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

  @Get(':listingId/images')
  findAll(
    @Param() params: ListingImageParamsDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingImageItemDto[]> {
    return this.listingImagesService.findAllByListing(
      params.listingId,
      user.id,
    );
  }

  @Patch(':listingId/images/order')
  reorder(
    @Param() params: ListingImageParamsDto,
    @Body() dto: ReorderListingImagesDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingImageItemDto[]> {
    return this.listingImagesService.reorder(params.listingId, user.id, dto);
  }

  @Delete(':listingId/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param() params: ListingImageItemParamsDto,
    @CurrentUser() user: SafeUser,
  ): Promise<void> {
    return this.listingImagesService.remove(
      params.listingId,
      params.imageId,
      user.id,
    );
  }
}
