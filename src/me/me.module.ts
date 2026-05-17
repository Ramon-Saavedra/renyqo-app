import { Module } from '@nestjs/common';

import { ListingsModule } from '../listings/listings.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [ListingsModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
