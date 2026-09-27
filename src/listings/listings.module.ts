import { Module } from '@nestjs/common';
import { ApplicantListingSummariesModule } from '../applicant-listing-summaries/applicant-listing-summaries.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ListingImagesModule } from '../listing-images/listing-images.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { PublishedListingsModule } from '../published-listings/published-listings.module';
import { SavedListingsModule } from '../saved-listings/saved-listings.module';

import { ApplicantListingsController } from './applicant-listings.controller';
import { ApplicantListingsService } from './applicant-listings.service';
import { ApplicantListingDiscoveryQuery } from './applicant-listing-discovery-query';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';

@Module({
  imports: [
    ListingImagesModule,
    EligibilityModule,
    ApplicationsModule,
    PublishedListingsModule,
    SavedListingsModule,
    ApplicantListingSummariesModule,
  ],
  controllers: [ListingsController, ApplicantListingsController],
  providers: [
    ListingsService,
    ApplicantListingsService,
    ApplicantListingDiscoveryQuery,
    ListingOrderingService,
    ListingInputRules,
    ListingResponseMapper,
  ],
  exports: [ListingsService],
})
export class ListingsModule {}
