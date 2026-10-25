import { Module } from '@nestjs/common';
import { ApplicationConsiderationReadService } from './application-consideration-read';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActivityReadService } from './application-activity-read.service';
import { ApplicationLifecycleReadService } from './application-lifecycle-read.service';
import { ApplicationAdmissionService } from './application-admission.service';

@Module({
  imports: [EligibilityModule],
  providers: [
    ApplicationConsiderationReadService,
    ApplicationActivityReadService,
    ApplicationLifecycleReadService,
    ApplicationAdmissionService,
  ],
  exports: [
    ApplicationConsiderationReadService,
    ApplicationActivityReadService,
    ApplicationLifecycleReadService,
    ApplicationAdmissionService,
  ],
})
export class ApplicationProcessReadModule {}
