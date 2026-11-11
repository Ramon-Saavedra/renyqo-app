import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { ListingImagesController } from './listing-images.controller';
import { ListingImagesService } from './listing-images.service';

@Module({
  imports: [ProviderAuthorizationModule],
  controllers: [ListingImagesController],
  providers: [CloudinaryService, ListingImagesService],
  exports: [CloudinaryService],
})
export class ListingImagesModule {}
