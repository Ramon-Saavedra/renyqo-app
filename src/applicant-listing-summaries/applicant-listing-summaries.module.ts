import { Module } from '@nestjs/common';

import { ApplicationsModule } from '../applications/applications.module';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicantListingSummaryService } from './applicant-listing-summary.service';

@Module({
  imports: [PrismaModule, ApplicationsModule, EligibilityModule],
  providers: [ApplicantListingSummaryService],
  exports: [ApplicantListingSummaryService],
})
export class ApplicantListingSummariesModule {}
