import { ForbiddenException, Injectable } from '@nestjs/common';

import type { SafeUser } from '../users/types/safe-user.type';
import type { OnboardingState } from './types/onboarding-state.type';

@Injectable()
export class MeService {
  getOnboardingState(user: SafeUser): OnboardingState {
    if (user.role === 'provider') {
      return {
        role: 'provider',
        hasCreatedFirstListing: false,
        nextStep: 'create_first_listing',
      };
    }

    if (user.role === 'applicant') {
      return {
        role: 'applicant',
        nextStep: 'applicant_area_pending',
      };
    }

    throw new ForbiddenException();
  }
}
