import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { ApplicantListingsPageDto } from '../listings/dto/applicant-listings-page.dto';
import type { SafeUser } from '../users/types/safe-user.type';
import { SavedListingsQueryDto } from '../saved-listings/dto/saved-listings-query.dto';
import { SavedListingsService } from '../saved-listings/saved-listings.service';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/saved-listings')
export class ApplicantSavedListingsController {
  constructor(private readonly savedListingsService: SavedListingsService) {}

  @Get()
  async findAll(
    @CurrentUser() user: SafeUser,
    @Query() query: SavedListingsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApplicantListingsPageDto> {
    return this.savedListingsService.findSavedListingsPage(user, query, res);
  }
}
