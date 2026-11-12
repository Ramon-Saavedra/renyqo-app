import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Body,
  Req,
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

@UseGuards(AuthenticatedGuard)
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
    @Req() request: Request,
  ): Promise<ListingImageResponseDto> {
    return this.listingImagesService.upload(
      params.listingId,
      providerActorFromRequest(request),
      file,
    );
  }

  @Get(':listingId/images')
  findAll(
    @Param() params: ListingImageParamsDto,
    @Req() request: Request,
  ): Promise<ListingImageItemDto[]> {
    return this.listingImagesService.findAllByListing(
      params.listingId,
      providerActorFromRequest(request),
    );
  }

  @Patch(':listingId/images/order')
  reorder(
    @Param() params: ListingImageParamsDto,
    @Body() dto: ReorderListingImagesDto,
    @Req() request: Request,
  ): Promise<ListingImageItemDto[]> {
    return this.listingImagesService.reorder(
      params.listingId,
      providerActorFromRequest(request),
      dto,
    );
  }

  @Delete(':listingId/images/:imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param() params: ListingImageItemParamsDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.listingImagesService.remove(
      params.listingId,
      params.imageId,
      providerActorFromRequest(request),
    );
  }
}
