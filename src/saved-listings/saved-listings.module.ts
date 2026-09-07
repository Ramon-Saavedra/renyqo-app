import { Module } from '@nestjs/common';

import { ApplicantListingSummariesModule } from '../applicant-listing-summaries/applicant-listing-summaries.module';
import { PublishedListingsModule } from '../published-listings/published-listings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SavedListingsService } from './saved-listings.service';

@Module({
  imports: [
    PrismaModule,
    PublishedListingsModule,
    ApplicantListingSummariesModule,
  ],
  providers: [SavedListingsService],
  exports: [SavedListingsService],
})
export class SavedListingsModule {}
