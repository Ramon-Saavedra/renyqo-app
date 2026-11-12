import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import { ForbiddenException, Injectable } from '@nestjs/common';

import { Role } from '../generated/prisma/enums';
import { ListingsService } from '../listings/listings.service';
import type { SafeUser } from '../users/types/safe-user.type';
import type { OnboardingState } from './types/onboarding-state.type';

@Injectable()
export class MeService {
  constructor(private readonly listingsService: ListingsService) {}

  async getOnboardingState(
    user: SafeUser,
    actor?: ProviderActor,
  ): Promise<OnboardingState> {
    if (actor || user.role === Role.PROVIDER) {
      if (!actor) return { role: 'provider', nextStep: 'select_workspace' };
      const count = await this.listingsService.countByProvider(actor);
      return {
        role: 'provider',
        hasCreatedFirstListing: count > 0,
        nextStep: count > 0 ? 'dashboard' : 'create_first_listing',
      };
    }

    if (user.role === Role.APPLICANT) {
      return {
        role: 'applicant',
        nextStep: 'browse_listings',
      };
    }

    throw new ForbiddenException();
  }
}
