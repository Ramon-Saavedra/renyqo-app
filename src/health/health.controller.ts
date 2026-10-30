import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { HealthService, type HealthStatus } from './health.service';
import { ReadinessService } from './readiness.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check(): HealthStatus {
    return this.healthService.check();
  }
}

@Controller()
export class ReadinessController {
  constructor(private readonly readinessService: ReadinessService) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    const status = await this.readinessService.check();
    if (status === 'unavailable') {
      throw new HttpException(
        { status: 'unavailable' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok' };
  }
}
