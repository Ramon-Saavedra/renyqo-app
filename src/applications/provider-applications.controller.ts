import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { Application } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider')
export class ProviderApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get('applications')
  findAll(@Req() req: Request): Promise<Application[]> {
    const user = req.user as SafeUser;
    return this.applicationsService.findAllByProvider(user.id);
  }

  @Get('listings/:id/applications')
  findByListing(
    @Param('id') listingId: string,
    @Req() req: Request,
  ): Promise<Application[]> {
    const user = req.user as SafeUser;
    return this.applicationsService.findAllByListing(listingId, user.id);
  }
}
