import { Module } from '@nestjs/common';
import { HealthController, ReadinessController } from './health.controller';
import { HealthService } from './health.service';
import { ReadinessService } from './readiness.service';

@Module({
  controllers: [HealthController, ReadinessController],
  providers: [HealthService, ReadinessService],
})
export class HealthModule {}
