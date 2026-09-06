import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ListingReportResponseDto } from './dto/listing-report-response.dto';
import { ReportListingDto } from './dto/report-listing.dto';
import { SaveListingResponseDto } from './dto/save-listing-response.dto';
import { ListingReportThrottlerGuard } from './guards/listing-report-throttler.guard';
import { ListingReportsService } from './listing-reports.service';
import { SavedListingsService } from '../saved-listings/saved-listings.service';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/listings')
export class ApplicantListingActionsController {
  constructor(
    private readonly savedListingsService: SavedListingsService,
    private readonly listingReportsService: ListingReportsService,
  ) {}

  @Put(':listingId/saved')
  @HttpCode(HttpStatus.OK)
  async save(
    @Param('listingId', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<SaveListingResponseDto> {
    const result = await this.savedListingsService.save(user.id, listingId);
    return new SaveListingResponseDto(result.saved, result.savedAt);
  }

  @Delete(':listingId/saved')
  @HttpCode(HttpStatus.OK)
  async unsave(
    @Param('listingId', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @CurrentUser() user: SafeUser,
  ): Promise<SaveListingResponseDto> {
    const result = await this.savedListingsService.unsave(user.id, listingId);
    return new SaveListingResponseDto(result.saved, result.savedAt);
  }

  @Post(':listingId/report')
  @UseGuards(ListingReportThrottlerGuard)
  @HttpCode(HttpStatus.CREATED)
  async report(
    @Param('listingId', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Body() dto: ReportListingDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ListingReportResponseDto> {
    const report = await this.listingReportsService.report(
      user.id,
      listingId,
      dto,
    );
    return new ListingReportResponseDto(report);
  }
}
