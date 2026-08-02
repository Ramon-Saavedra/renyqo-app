import { Module } from '@nestjs/common';
import { ListingImagesModule } from '../listing-images/listing-images.module';

import { ApplicantListingsController } from './applicant-listings.controller';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [ListingImagesModule],
  controllers: [ListingsController, ApplicantListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
