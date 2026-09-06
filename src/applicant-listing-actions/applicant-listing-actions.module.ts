import { Module } from '@nestjs/common';

import { PublishedListingsModule } from '../published-listings/published-listings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SavedListingsModule } from '../saved-listings/saved-listings.module';
import { ApplicantListingActionsController } from './applicant-listing-actions.controller';
import { ApplicantSavedListingsController } from './applicant-saved-listings.controller';
import { ListingReportThrottlerStorage } from './listing-report-throttler.storage';
import { ListingReportsService } from './listing-reports.service';
import { ListingReportThrottlerGuard } from './guards/listing-report-throttler.guard';

@Module({
  imports: [PrismaModule, PublishedListingsModule, SavedListingsModule],
  controllers: [
    ApplicantListingActionsController,
    ApplicantSavedListingsController,
  ],
  providers: [
    ListingReportsService,
    ListingReportThrottlerGuard,
    ListingReportThrottlerStorage,
  ],
})
export class ApplicantListingActionsModule {}
