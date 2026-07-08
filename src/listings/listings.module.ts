import { Module } from '@nestjs/common';
import { ListingImagesModule } from '../listing-images/listing-images.module';

import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [ListingImagesModule],
  controllers: [ListingsController],
  providers: [ListingsService],
  exports: [ListingsService],
})
export class ListingsModule {}
