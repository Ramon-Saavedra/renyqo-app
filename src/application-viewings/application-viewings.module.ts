import { OutboxModule } from '../outbox/outbox.module';
import { ViewingWorkflowExpiryService } from './viewing-workflow-expiry.service';
import { ViewingExpiryScheduler } from './viewing-expiry-scheduler.service';
import { ViewingWorkflowHistoryQueryService } from './viewing-workflow-history-query.service';
import { Module } from '@nestjs/common';
import { ViewingWorkflowDecisionService } from './viewing-workflow-decision.service';
import { ApplicationsModule } from '../applications/applications.module';
import { ApplicationViewingAccessService } from './application-viewing-access.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import { ApplicationViewingService } from './application-viewing.service';
import { ApplicationViewingReadModule } from './application-viewing-read.module';
import { ApplicantViewingsController } from './applicant-viewings.controller';
import { ProviderViewingsController } from './provider-viewings.controller';
import { ProviderViewingWorkflowController } from './provider-viewing-workflow.controller';
import { ApplicantViewingWorkflowController } from './applicant-viewing-workflow.controller';
import { ViewingWorkflowCommandService } from './viewing-workflow-command.service';
import { ViewingWorkflowCommandPolicy } from './viewing-workflow-command.policy';

@Module({
  imports: [OutboxModule, ApplicationsModule, ApplicationViewingReadModule],
  controllers: [
    ProviderViewingsController,
    ApplicantViewingsController,
    ProviderViewingWorkflowController,
    ApplicantViewingWorkflowController,
  ],
  providers: [
    ViewingWorkflowExpiryService,
    ViewingExpiryScheduler,
    ViewingWorkflowHistoryQueryService,
    ViewingWorkflowDecisionService,
    ApplicationViewingService,
    ApplicationViewingOutcomeService,
    ApplicationViewingAccessService,
    ApplicationViewingQueryService,
    ViewingWorkflowCommandService,
    ViewingWorkflowCommandPolicy,
  ],
  exports: [ApplicationViewingService],
})
export class ApplicationViewingsModule {}
