import { Module } from '@nestjs/common';
import { SessionInfrastructureService } from './session-infrastructure.service';

@Module({
  providers: [SessionInfrastructureService],
  exports: [SessionInfrastructureService],
})
export class SessionModule {}
