import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActionThrottlerStorage } from './application-action-throttler.storage';
import { ApplicationActivityService } from './application-activity.service';
import { ApplicationLifecycleService } from './application-lifecycle.service';
import { ApplicationProcessQueryService } from './application-process-query.service';
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
  imports: [PrismaModule, EligibilityModule],
  controllers: [
    ApplicationsController,
    ApplicantApplicationsController,
    ApplicantApplicationActionsController,
    ProviderApplicationsController,
  ],
  providers: [
    ApplicationActivityService,
    ApplicationLifecycleService,
    ApplicationProcessQueryService,
    ApplicationTransactionService,
    ApplicationWaitingPromotionService,
    ProviderApplicationCurationService,
    ApplicationsService,
    ApplicantApplicationActionThrottlerGuard,
    ApplicationActionThrottlerStorage,
  ],
  exports: [
    ApplicationsService,
    ApplicationLifecycleService,
    ApplicationActivityService,
  ],
})
export class ApplicationsModule {}
