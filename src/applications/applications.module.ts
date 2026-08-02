import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicantApplicationsController } from './applicant-applications.controller';
import { ApplicantApplicationActionsController } from './applicant-application-actions.controller';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ProviderApplicationsController } from './provider-applications.controller';

@Module({
  imports: [PrismaModule, EligibilityModule],
  controllers: [
    ApplicationsController,
    ApplicantApplicationsController,
    ApplicantApplicationActionsController,
    ProviderApplicationsController,
  ],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
