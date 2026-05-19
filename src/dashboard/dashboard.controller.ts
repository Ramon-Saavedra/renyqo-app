import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from './types/dashboard-summary.type';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  getSummary(@Req() req: Request): Promise<DashboardSummary> {
    const user = req.user as SafeUser;
    return this.dashboardService.getSummary(user.id);
  }
}
