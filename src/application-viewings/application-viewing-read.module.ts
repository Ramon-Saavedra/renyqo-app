import { Module } from '@nestjs/common';
import { ApplicationViewingReadService } from './application-viewing-read.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
} from './application-viewing.policy';

@Module({
  providers: [
    ApplicationViewingReadService,
    ApplicationViewingPolicy,
    ViewingClock,
  ],
  exports: [
    ApplicationViewingReadService,
    ApplicationViewingPolicy,
    ViewingClock,
  ],
})
export class ApplicationViewingReadModule {}
