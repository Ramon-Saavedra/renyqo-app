import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { Application } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider')
export class ProviderApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get('applications')
  findAll(@CurrentUser() user: SafeUser): Promise<Application[]> {
    return this.applicationsService.findAllByProvider(user.id);
  }

  @Get('listings/:id/applications')
  findByListing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<Application[]> {
    return this.applicationsService.findAllByListing(listingId, user.id);
  }
}
