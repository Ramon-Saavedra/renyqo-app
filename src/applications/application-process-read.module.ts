import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActivityReadService } from './application-activity-read.service';
import { ApplicationLifecycleReadService } from './application-lifecycle-read.service';
import { ApplicationAdmissionService } from './application-admission.service';

@Module({
  imports: [EligibilityModule],
  providers: [
    ApplicationActivityReadService,
    ApplicationLifecycleReadService,
    ApplicationAdmissionService,
  ],
  exports: [
    ApplicationActivityReadService,
    ApplicationLifecycleReadService,
    ApplicationAdmissionService,
  ],
})
export class ApplicationProcessReadModule {}
