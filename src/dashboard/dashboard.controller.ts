import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from './types/dashboard-summary.type';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  getSummary(@CurrentUser() user: SafeUser): Promise<DashboardSummary> {
    return this.dashboardService.getSummary(user.id);
  }
}
