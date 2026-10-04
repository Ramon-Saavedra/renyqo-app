import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationViewingAccessService } from './application-viewing-access.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import { ApplicationViewingService } from './application-viewing.service';
import { ApplicationViewingReadModule } from './application-viewing-read.module';
import { ApplicantViewingsController } from './applicant-viewings.controller';
import { ProviderViewingsController } from './provider-viewings.controller';

@Module({
  imports: [ApplicationsModule, ApplicationViewingReadModule],
  controllers: [ProviderViewingsController, ApplicantViewingsController],
  providers: [
    ApplicationViewingService,
    ApplicationViewingOutcomeService,
    ApplicationViewingAccessService,
    ApplicationViewingQueryService,
  ],
})
export class ApplicationViewingsModule {}
