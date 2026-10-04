import { Module } from '@nestjs/common';
import { EligibilityModule } from '../eligibility/eligibility.module';
import { ApplicationActivityReadService } from './application-activity-read.service';
import { ApplicationLifecycleReadService } from './application-lifecycle-read.service';

@Module({
  imports: [EligibilityModule],
  providers: [ApplicationActivityReadService, ApplicationLifecycleReadService],
  exports: [ApplicationActivityReadService, ApplicationLifecycleReadService],
})
export class ApplicationProcessReadModule {}
