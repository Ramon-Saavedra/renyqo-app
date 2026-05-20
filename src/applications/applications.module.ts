import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ApplicantApplicationsController } from './applicant-applications.controller';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { ProviderApplicationsController } from './provider-applications.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    ApplicationsController,
    ApplicantApplicationsController,
    ProviderApplicationsController,
  ],
  providers: [ApplicationsService],
})
export class ApplicationsModule {}
