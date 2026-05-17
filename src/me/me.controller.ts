import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { MeService } from './me.service';
import type { OnboardingState } from './types/onboarding-state.type';

@UseGuards(AuthenticatedGuard)
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('onboarding-state')
  async getOnboardingState(@Req() req: Request): Promise<OnboardingState> {
    return this.meService.getOnboardingState(req.user as SafeUser);
  }
}
