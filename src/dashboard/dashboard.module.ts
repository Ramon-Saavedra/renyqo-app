import { Module } from '@nestjs/common';

import { ListingsModule } from '../listings/listings.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ListingsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
