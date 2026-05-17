import { ForbiddenException, Injectable } from '@nestjs/common';

import { Role } from '../generated/prisma/enums';
import { ListingsService } from '../listings/listings.service';
import type { SafeUser } from '../users/types/safe-user.type';
import type { OnboardingState } from './types/onboarding-state.type';

@Injectable()
export class MeService {
  constructor(private readonly listingsService: ListingsService) {}

  async getOnboardingState(user: SafeUser): Promise<OnboardingState> {
    if (user.role === Role.PROVIDER) {
      const count = await this.listingsService.countByProvider(user.id);
      return {
        role: 'provider',
        hasCreatedFirstListing: count > 0,
        nextStep: count > 0 ? 'dashboard' : 'create_first_listing',
      };
    }

    if (user.role === Role.APPLICANT) {
      return {
        role: 'applicant',
        nextStep: 'applicant_area_pending',
      };
    }

    throw new ForbiddenException();
  }
}
