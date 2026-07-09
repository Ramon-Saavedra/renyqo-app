import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Role, UserStatus } from '../generated/prisma/enums';
import { ListingsService } from '../listings/listings.service';
import type { SafeUser } from '../users/types/safe-user.type';
import { MeService } from './me.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const makeSafeUser = (role: SafeUser['role']): SafeUser => ({
  id: USER_ID,
  name: 'Test User',
  email: 'test@example.com',
  role,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date(),
  acceptedPrivacyAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('MeService', () => {
  let service: MeService;
  let listingsService: jest.Mocked<ListingsService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MeService,
        {
          provide: ListingsService,
          useValue: { countByProvider: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(MeService);
    listingsService = module.get<jest.Mocked<ListingsService>>(ListingsService);
  });

  describe('getOnboardingState', () => {
    it('returns create_first_listing state for a new provider', async () => {
      listingsService.countByProvider.mockResolvedValue(0);

      const result = await service.getOnboardingState(
        makeSafeUser(Role.PROVIDER),
      );

      expect(result).toEqual({
        role: 'provider',
        hasCreatedFirstListing: false,
        nextStep: 'create_first_listing',
      });
    });

    it('returns dashboard state for a provider with at least one listing', async () => {
      listingsService.countByProvider.mockResolvedValue(1);

      const result = await service.getOnboardingState(
        makeSafeUser(Role.PROVIDER),
      );

      expect(result).toEqual({
        role: 'provider',
        hasCreatedFirstListing: true,
        nextStep: 'dashboard',
      });
    });

    it('returns browse_listings state for an applicant', async () => {
      const result = await service.getOnboardingState(
        makeSafeUser(Role.APPLICANT),
      );

      expect(result).toEqual({
        role: 'applicant',
        nextStep: 'browse_listings',
      });
    });

    it('throws ForbiddenException for admin role', async () => {
      await expect(
        service.getOnboardingState(makeSafeUser(Role.ADMIN)),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
