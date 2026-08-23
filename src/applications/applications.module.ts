import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActionThrottlerStorage } from './application-action-throttler.storage';
import { ApplicantApplicationsController } from './applicant-applications.controller';
import { ApplicantApplicationActionsController } from './applicant-application-actions.controller';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
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
    ApplicationsService,
    ApplicantApplicationActionThrottlerGuard,
    ApplicationActionThrottlerStorage,
  ],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
