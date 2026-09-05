import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { ObjectType, Role } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import { ProfileMatch } from './dto/applicant-listing-profile-match.enum';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import { ApplicantListingsController } from './applicant-listings.controller';
import { ListingsService } from './listings.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000002';

describe('ApplicantListingsController', () => {
  let controller: ApplicantListingsController;
  let listingsService: jest.Mocked<
    Pick<
      ListingsService,
      | 'findPublishedForApplicant'
      | 'findPublishedDetailForApplicant'
      | 'isProfileCompleteForUser'
    >
  >;

  beforeEach(async () => {
    listingsService = {
      findPublishedForApplicant: jest.fn(),
      findPublishedDetailForApplicant: jest.fn(),
      isProfileCompleteForUser: jest
        .fn<(userId: string) => Promise<boolean>>()
        .mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantListingsController],
      providers: [{ provide: ListingsService, useValue: listingsService }],
    }).compile();

    controller = module.get<ApplicantListingsController>(
      ApplicantListingsController,
    );
  });

  it('keeps public listing routes free of authentication guards', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ApplicantListingsController),
    ).toBeUndefined();
  });

  describe('findAll', () => {
    it('returns a paginated list of published listings', async () => {
      const page = new ApplicantListingsPageDto([], null, 0);
      listingsService.findPublishedForApplicant.mockResolvedValue(page);

      const result = await controller.findAll({}, null, {
        setHeader: jest.fn(),
      } as never);

      expect(listingsService.findPublishedForApplicant).toHaveBeenCalledWith(
        {},
        null,
        expect.any(Object),
      );
      expect(result).toBe(page);
    });

    it('passes query filters to the service', async () => {
      const page = new ApplicantListingsPageDto([], null, 0);
      listingsService.findPublishedForApplicant.mockResolvedValue(page);

      await controller.findAll({ city: 'Berlin', minRent: 500 }, null, {
        setHeader: jest.fn(),
      } as never);

      expect(listingsService.findPublishedForApplicant).toHaveBeenCalledWith(
        {
          city: 'Berlin',
          minRent: 500,
        },
        null,
        expect.any(Object),
      );
    });

    it('throws BadRequestException when onlyMatching is true with null user', async () => {
      await expect(
        controller.findAll({ onlyMatching: true }, null, {
          setHeader: jest.fn(),
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when onlyMatching is true with provider user', async () => {
      const providerUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Provider',
        email: 'provider@test.com',
        role: Role.PROVIDER,
        providerType: 'private',
        companyName: null,
        emailVerified: false,
        status: 'ACTIVE' as const,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      await expect(
        controller.findAll({ onlyMatching: true }, providerUser, {
          setHeader: jest.fn(),
        } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when onlyMatching is true with applicant with incomplete profile', async () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Applicant',
        email: 'applicant@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: 'ACTIVE' as const,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      listingsService.isProfileCompleteForUser.mockResolvedValue(false);

      await expect(
        controller.findAll({ onlyMatching: true }, applicantUser, {
          setHeader: jest.fn(),
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls service successfully when onlyMatching is true with applicant with complete profile', async () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Applicant',
        email: 'applicant@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: 'ACTIVE' as const,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      const page = new ApplicantListingsPageDto([], null, 0);
      listingsService.isProfileCompleteForUser.mockResolvedValue(true);
      listingsService.findPublishedForApplicant.mockResolvedValue(page);

      const result = await controller.findAll(
        { onlyMatching: true },
        applicantUser,
        { setHeader: jest.fn() } as never,
      );

      expect(listingsService.findPublishedForApplicant).toHaveBeenCalledWith(
        { onlyMatching: true },
        applicantUser,
        expect.any(Object),
      );
      expect(result).toBe(page);
    });

    it('sets cache-control headers on the response', async () => {
      const page = new ApplicantListingsPageDto([], null, 0);
      const res = { setHeader: jest.fn() };
      listingsService.findPublishedForApplicant.mockImplementation(
        (_query, _user, resArg) => {
          if (resArg) {
            resArg.setHeader('Vary', 'Cookie');
            resArg.setHeader(
              'Cache-Control',
              'private, no-store, must-revalidate',
            );
          }
          return Promise.resolve(page);
        },
      );

      await controller.findAll({}, null, res as never);

      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store, must-revalidate',
      );
    });
  });

  describe('findOne', () => {
    it('returns a published listing detail', async () => {
      const detail = new ApplicantListingDetailDto(
        {
          id: LISTING_ID,
          title: 'Test',
          city: 'Berlin',
          zip: '10115',
          district: 'Mitte',
          street: null,
          showExactAddress: false,
          objectType: ObjectType.APARTMENT,
          livingArea: 62,
          rooms: 2,
          bedrooms: 1,
          coldRent: 1200,
          additionalCosts: 250,
          deposit: 2400,
          depositMonths: 2,
          availableFrom: new Date('2026-09-01'),
          shortDescription: null,
          minimumHouseholdNetIncome: null,
          schufaRequired: false,
          incomeProofRequired: false,
          suitableForPeopleCount: null,
          petsPolicy: null,
          smokingPolicy: null,
          publishedAt: new Date('2026-07-01'),
          images: [],
        },
        ProfileMatch.UNKNOWN,
        new Date('2025-01-01'),
        {
          hasApplied: false,
          applicationStatus: null,
          publicReason: null,
        },
      );
      listingsService.findPublishedDetailForApplicant.mockResolvedValue(detail);

      const result = await controller.findOne(LISTING_ID, null, {
        setHeader: jest.fn(),
      } as never);

      expect(
        listingsService.findPublishedDetailForApplicant,
      ).toHaveBeenCalledWith(LISTING_ID, null, expect.any(Object));
      expect(result).toBe(detail);
    });
  });
});
