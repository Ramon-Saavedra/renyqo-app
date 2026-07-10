import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
import { MeService } from './me.service';
import type { OnboardingState } from './types/onboarding-state.type';

@UseGuards(AuthenticatedGuard)
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('onboarding-state')
  async getOnboardingState(
    @CurrentUser() user: SafeUser,
  ): Promise<OnboardingState> {
    return this.meService.getOnboardingState(user);
  }
}
