import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { memoryStorage } from 'multer';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { Application, Listing } from '../generated/prisma/client';
import {
  LISTING_IMAGE_FILE_FIELD,
  MAX_LISTING_IMAGE_FILE_SIZE_BYTES,
  OPTIONAL_LISTING_IMAGE_FILE_PIPE,
} from '../listing-images/listing-image-upload.constants';
import type { SafeUser } from '../users/types/safe-user.type';
import { CreateListingDto } from './dto/create-listing.dto';
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
  create(
    @Body() dto: CreateListingDto,
    @UploadedFile(OPTIONAL_LISTING_IMAGE_FILE_PIPE)
    file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.create(user.id, dto, file);
  }

  @Get()
  findAll(@Req() req: Request): Promise<Listing[]> {
    const user = req.user as SafeUser;
    return this.listingsService.findAllByProvider(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Request): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.findOneByProvider(id, user.id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
    @Req() req: Request,
  ): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.update(id, user.id, dto);
  }

  @Patch(':id/publish')
  publish(@Param('id') id: string, @Req() req: Request): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.publish(id, user.id);
  }

  @Patch(':id/draft')
  moveToDraft(@Param('id') id: string, @Req() req: Request): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.moveToDraft(id, user.id);
  }

  @Patch(':id/archive')
  archive(@Param('id') id: string, @Req() req: Request): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.archive(id, user.id);
  }

  @Get(':id/active-applications')
  getActiveApplications(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<Application[]> {
    const user = req.user as SafeUser;
    return this.listingsService.getActiveApplications(id, user.id);
  }
}
