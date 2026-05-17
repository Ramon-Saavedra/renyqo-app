import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from '@jest/globals';

import type { SafeUser } from '../users/types/safe-user.type';
import { MeService } from './me.service';

const makeSafeUser = (role: SafeUser['role']): SafeUser => ({
  id: 'user-id',
  name: 'Test User',
  email: 'test@example.com',
  role,
  emailVerified: false,
  status: 'active',
  acceptedTermsAt: new Date(),
  acceptedPrivacyAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('MeService', () => {
  let service: MeService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [MeService],
    }).compile();

    service = module.get(MeService);
  });

  describe('getOnboardingState', () => {
    it('returns create_first_listing state for a new provider', () => {
      const result = service.getOnboardingState(makeSafeUser('provider'));

      expect(result).toEqual({
        role: 'provider',
        hasCreatedFirstListing: false,
        nextStep: 'create_first_listing',
      });
    });

    it('returns applicant_area_pending state for an applicant', () => {
      const result = service.getOnboardingState(makeSafeUser('applicant'));

      expect(result).toEqual({
        role: 'applicant',
        nextStep: 'applicant_area_pending',
      });
    });

    it('throws ForbiddenException for admin role', () => {
      expect(() => service.getOnboardingState(makeSafeUser('admin'))).toThrow(
        ForbiddenException,
      );
    });
  });
});
