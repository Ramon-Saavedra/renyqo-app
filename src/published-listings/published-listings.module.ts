import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { PublishedListingsService } from './published-listings.service';

@Module({
  imports: [PrismaModule],
  providers: [PublishedListingsService],
  exports: [PublishedListingsService],
})
export class PublishedListingsModule {}
