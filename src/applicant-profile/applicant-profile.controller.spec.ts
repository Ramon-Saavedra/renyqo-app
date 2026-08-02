import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile } from '../generated/prisma/client';
import { SmokingStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { UserStatus } from '../generated/prisma/enums';
import { Role } from '../generated/prisma/enums';
import { ApplicantProfileController } from './applicant-profile.controller';
import { ApplicantProfileService } from './applicant-profile.service';
import { ApplicantProfileResponseDto } from './dto/applicant-profile-response.dto';
import { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_ID = '00000000-0000-4000-8000-000000000002';

const makeApplicantUser = (): SafeUser => ({
  id: APPLICANT_ID,
  name: 'Applicant',
  email: 'applicant@example.com',
  role: Role.APPLICANT,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const makeProfile = (): ApplicantProfile => ({
  id: PROFILE_ID,
  applicantId: APPLICANT_ID,
  householdNetIncome: 3000,
  incomeProofAvailable: true,
  schufaAvailable: false,
  peopleCount: 2,
  adultsCount: 2,
  childrenCount: 0,
  hasPets: false,
  petsNote: null,
  smokingStatus: SmokingStatus.NON_SMOKER,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

describe('ApplicantProfileController', () => {
  let controller: ApplicantProfileController;
  let applicantProfileService: jest.Mocked<ApplicantProfileService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantProfileController],
      providers: [
        {
          provide: ApplicantProfileService,
          useValue: {
            findByApplicant: jest.fn(),
            upsert: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ApplicantProfileController>(
      ApplicantProfileController,
    );
    applicantProfileService = module.get(ApplicantProfileService);
  });

  describe('getProfile', () => {
    it('returns the profile', async () => {
      const profile = makeProfile();
      applicantProfileService.findByApplicant.mockResolvedValue(profile);

      const result = await controller.getProfile(makeApplicantUser());

      expect(result).toBeInstanceOf(ApplicantProfileResponseDto);
      expect(result.householdNetIncome).toBe(3000);
      expect(result.adultsCount).toBe(2);
      expect(result.childrenCount).toBe(0);
      expect(result.peopleCount).toBe(2);
    });

    it('does not expose internal fields', async () => {
      const profile = makeProfile();
      applicantProfileService.findByApplicant.mockResolvedValue(profile);

      const result = await controller.getProfile(makeApplicantUser());
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('applicantId');
      expect(result).not.toHaveProperty('createdAt');
      expect(result).not.toHaveProperty('updatedAt');
    });

    it('throws NotFoundException when profile is missing', async () => {
      applicantProfileService.findByApplicant.mockResolvedValue(null);

      await expect(controller.getProfile(makeApplicantUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates and returns the profile', async () => {
      const profile = makeProfile();
      const dto: UpdateApplicantProfileDto = { householdNetIncome: 4000 };
      applicantProfileService.upsert.mockResolvedValue({
        ...profile,
        householdNetIncome: 4000,
      });

      const result = await controller.updateProfile(makeApplicantUser(), dto);

      expect(result).toBeInstanceOf(ApplicantProfileResponseDto);
      expect(result.householdNetIncome).toBe(4000);
    });

    it('does not expose internal fields on update', async () => {
      const profile = makeProfile();
      applicantProfileService.upsert.mockResolvedValue(profile);

      const result = await controller.updateProfile(makeApplicantUser(), {
        householdNetIncome: 4000,
      });
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('applicantId');
    });
  });
});
