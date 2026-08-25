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

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import {
  LISTING_IMAGE_FILE_FIELD,
  LISTING_IMAGE_MULTER_OPTIONS,
  OPTIONAL_LISTING_IMAGE_FILE_PIPE,
} from '../listing-images/listing-image-upload.constants';
import type { SafeUser } from '../users/types/safe-user.type';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import { ProviderListingOverviewResponseDto } from './dto/provider-listing-overview-response.dto';
import { RentListingDto } from './dto/rent-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor(LISTING_IMAGE_FILE_FIELD, LISTING_IMAGE_MULTER_OPTIONS),
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
  async findAll(
    @CurrentUser() user: SafeUser,
  ): Promise<ProviderListingOverviewResponseDto[]> {
    const listings = await this.listingsService.findAllByProvider(user.id);
    return this.listingsService.toProviderListingOverviewResponses(listings, {
      exposeExactAddress: true,
    });
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.findOneDetailByProvider(
      id,
      user.id,
    );
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

  @Patch(':id/rent')
  async rent(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RentListingDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.rentListing(id, user.id, dto);
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }
}
