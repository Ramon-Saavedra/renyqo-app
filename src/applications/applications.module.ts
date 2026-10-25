import { OutboxModule } from '../outbox/outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Module } from '@nestjs/common';
import { ApplicationConsiderationService } from './application-consideration.service';
import { ApplicationViewingReadModule } from '../application-viewings/application-viewing-read.module';
import { ViewingLifecycleService } from './viewing-lifecycle.service';
import { ApplicationAttentionModule } from '../application-attention/application-attention.module';
import { ApplicationProcessReadModule } from './application-process-read.module';

import { PrismaModule } from '../prisma/prisma.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActionThrottlerStorage } from './application-action-throttler.storage';
import { ApplicationActivityService } from './application-activity.service';
import { ApplicationLifecycleService } from './application-lifecycle.service';
import { ApplicationProcessQueryService } from './application-process-query.service';
import { ProviderRecentExitsQueryService } from './provider-recent-exits-query.service';
import { ApplicationTransactionService } from './application-transaction.service';
import { ApplicationWaitingPromotionService } from './application-waiting-promotion.service';
import { ApplicantApplicationsController } from './applicant-applications.controller';
import { ApplicantApplicationActionsController } from './applicant-application-actions.controller';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ProviderApplicationCurationService } from './provider-application-curation.service';
import { ProviderApplicationsController } from './provider-applications.controller';
import { ApplicantApplicationActionThrottlerGuard } from './guards/applicant-application-action-throttler.guard';

@Module({
  imports: [
    NotificationsModule,
    OutboxModule,
    ApplicationViewingReadModule,
    PrismaModule,
    EligibilityModule,
    ApplicationProcessReadModule,
    ApplicationAttentionModule,
  ],
  controllers: [
    ApplicationsController,
    ApplicantApplicationsController,
    ApplicantApplicationActionsController,
    ProviderApplicationsController,
  ],
  providers: [
    ApplicationConsiderationService,
    ViewingLifecycleService,
    ApplicationActivityService,
    ApplicationLifecycleService,
    ApplicationProcessQueryService,
    ProviderRecentExitsQueryService,
    ApplicationTransactionService,
    ApplicationWaitingPromotionService,
    ProviderApplicationCurationService,
    ApplicationsService,
    ApplicantApplicationActionThrottlerGuard,
    ApplicationActionThrottlerStorage,
  ],
  exports: [
    ApplicationConsiderationService,
    ViewingLifecycleService,
    ProviderApplicationCurationService,
    ProviderRecentExitsQueryService,
    ApplicationsService,
    ApplicationLifecycleService,
    ApplicationActivityService,
  ],
})
export class ApplicationsModule {}
