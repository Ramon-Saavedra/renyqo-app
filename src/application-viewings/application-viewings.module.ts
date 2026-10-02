import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationViewingAccessService } from './application-viewing-access.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import { ApplicationViewingService } from './application-viewing.service';
import {
  ApplicationViewingPolicy,
  ViewingClock,
} from './application-viewing.policy';
import { ApplicantViewingsController } from './applicant-viewings.controller';
import { ProviderViewingsController } from './provider-viewings.controller';

@Module({
  imports: [ApplicationsModule],
  controllers: [ProviderViewingsController, ApplicantViewingsController],
  providers: [
    ApplicationViewingService,
    ApplicationViewingOutcomeService,
    ApplicationViewingAccessService,
    ApplicationViewingQueryService,
    ApplicationViewingPolicy,
    ViewingClock,
  ],
})
export class ApplicationViewingsModule {}
