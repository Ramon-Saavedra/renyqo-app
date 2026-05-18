import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { Listing } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { CreateListingDto } from './dto/create-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/listings')
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Post()
  create(@Body() dto: CreateListingDto, @Req() req: Request): Promise<Listing> {
    const user = req.user as SafeUser;
    return this.listingsService.create(user.id, dto);
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
}
