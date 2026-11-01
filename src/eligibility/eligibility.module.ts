import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';
import { ListingCriteriaRevisionService } from './listing-criteria-revision.service';
import { ApplicationEligibilityAssessmentService } from './application-eligibility-assessment.service';
import { ApplicationEligibilityReadController } from './application-eligibility-read.controller';

@Module({
  imports: [PrismaModule],
  controllers: [EligibilityController, ApplicationEligibilityReadController],
  providers: [
    EligibilityService,
    ListingCriteriaRevisionService,
    ApplicationEligibilityAssessmentService,
  ],
  exports: [
    EligibilityService,
    ListingCriteriaRevisionService,
    ApplicationEligibilityAssessmentService,
  ],
})
export class EligibilityModule {}
