import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  ParseUUIDPipe,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { Application } from '../generated/prisma/client';
import {
  LISTING_IMAGE_FILE_FIELD,
  MAX_LISTING_IMAGE_FILE_SIZE_BYTES,
  OPTIONAL_LISTING_IMAGE_FILE_PIPE,
} from '../listing-images/listing-image-upload.constants';
import type { SafeUser } from '../users/types/safe-user.type';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor(LISTING_IMAGE_FILE_FIELD, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_LISTING_IMAGE_FILE_SIZE_BYTES, files: 1 },
    }),
  )
  async create(
    @Body() dto: CreateListingDto,
    @UploadedFile(OPTIONAL_LISTING_IMAGE_FILE_PIPE)
    file: Express.Multer.File | undefined,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.create(user.id, dto, file);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Get()
  async findAll(@CurrentUser() user: SafeUser): Promise<ListingResponseDto[]> {
    const listings = await this.listingsService.findAllByProvider(user.id);
    return this.listingsService.toListingResponses(listings, {
      exposeExactAddress: true,
    });
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.findOneByProvider(id, user.id);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateListingDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.update(id, user.id, dto);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/publish')
  async publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.publish(id, user.id);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/draft')
  async moveToDraft(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.moveToDraft(id, user.id);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/archive')
  async archive(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.archive(id, user.id);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Get(':id/active-applications')
  getActiveApplications(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<Application[]> {
    return this.listingsService.getActiveApplications(id, user.id);
  }
}
