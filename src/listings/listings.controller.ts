import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import {
  Body,
  Req,
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
import {
  LISTING_IMAGE_FILE_FIELD,
  LISTING_IMAGE_MULTER_OPTIONS,
  OPTIONAL_LISTING_IMAGE_FILE_PIPE,
} from '../listing-images/listing-image-upload.constants';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import { ProviderListingOverviewResponseDto } from './dto/provider-listing-overview-response.dto';
import { RentListingDto } from './dto/rent-listing.dto';
import { UpdateListingPositionDto } from './dto/update-listing-position.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@UseGuards(AuthenticatedGuard)
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
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.create(
      providerActorFromRequest(request),
      dto,
      file,
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Get()
  async findAll(
    @Req() request: Request,
  ): Promise<ProviderListingOverviewResponseDto[]> {
    const listings = await this.listingsService.findAllByProvider(
      providerActorFromRequest(request),
    );
    return this.listingsService.toProviderListingOverviewResponses(listings, {
      exposeExactAddress: true,
    });
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.findOneDetailByProvider(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateListingDto,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.update(
      id,
      providerActorFromRequest(request),
      dto,
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/publish')
  async publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.publish(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/draft')
  async moveToDraft(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.moveToDraft(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/retire')
  async retire(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.retire(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/pause')
  async pause(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.pause(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/resume')
  async resume(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.resume(
      id,
      providerActorFromRequest(request),
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/rent')
  async rent(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RentListingDto,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.rentListing(
      id,
      providerActorFromRequest(request),
      dto,
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }

  @Patch(':id/position')
  async updatePosition(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateListingPositionDto,
    @Req() request: Request,
  ): Promise<ListingResponseDto> {
    const listing = await this.listingsService.updatePosition(
      id,
      providerActorFromRequest(request),
      dto,
    );
    return this.listingsService.toListingResponse(listing, {
      exposeExactAddress: true,
    });
  }
}
