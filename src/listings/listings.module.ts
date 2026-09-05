import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ListingImagesModule } from '../listing-images/listing-images.module';
import { EligibilityModule } from '../eligibility/eligibility.module';

import { ApplicantListingsController } from './applicant-listings.controller';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [ListingImagesModule, EligibilityModule, ApplicationsModule],
  controllers: [ListingsController, ApplicantListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
