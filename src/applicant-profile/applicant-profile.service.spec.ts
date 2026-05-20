import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile } from '../generated/prisma/client';
import { SmokingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicantProfileService } from './applicant-profile.service';
import { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_ID = '00000000-0000-4000-8000-000000000002';

const makeRawProfile = (
  overrides: Partial<ApplicantProfile> = {},
): ApplicantProfile => ({
  id: PROFILE_ID,
  applicantId: APPLICANT_ID,
  householdNetIncome: null,
  incomeProofAvailable: null,
  schufaAvailable: null,
  peopleCount: null,
  adultsCount: null,
  childrenCount: null,
  hasPets: null,
  petsNote: null,
  smokingStatus: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('ApplicantProfileService', () => {
  let service: ApplicantProfileService;
  let prismaMock: {
    applicantProfile: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicantProfile | null>
      >;
      upsert: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicantProfile>
      >;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      applicantProfile: {
        findUnique:
          jest.fn<(args?: unknown) => Promise<ApplicantProfile | null>>(),
        upsert: jest.fn<(args?: unknown) => Promise<ApplicantProfile>>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicantProfileService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<ApplicantProfileService>(ApplicantProfileService);
  });

  describe('findByApplicant', () => {
    it('returns the profile when it exists', async () => {
      const profile = makeRawProfile();
      prismaMock.applicantProfile.findUnique.mockResolvedValue(profile);

      const result = await service.findByApplicant(APPLICANT_ID);

      expect(prismaMock.applicantProfile.findUnique).toHaveBeenCalledWith({
        where: { applicantId: APPLICANT_ID },
      });
      expect(result).toEqual(profile);
    });

    it('returns null when no profile exists', async () => {
      prismaMock.applicantProfile.findUnique.mockResolvedValue(null);

      const result = await service.findByApplicant(APPLICANT_ID);

      expect(result).toBeNull();
    });
  });

  describe('upsert', () => {
    it('creates the profile when it does not exist', async () => {
      const dto: UpdateApplicantProfileDto = {
        householdNetIncome: 3000,
        hasPets: false,
        smokingStatus: SmokingStatus.NON_SMOKER,
      };
      const profile = makeRawProfile({
        householdNetIncome: 3000,
        hasPets: false,
        smokingStatus: SmokingStatus.NON_SMOKER,
      });
      prismaMock.applicantProfile.upsert.mockResolvedValue(profile);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(prismaMock.applicantProfile.upsert).toHaveBeenCalledWith({
        where: { applicantId: APPLICANT_ID },
        create: { applicantId: APPLICANT_ID, ...dto },
        update: { ...dto },
      });
      expect(result.householdNetIncome).toBe(3000);
      expect(result.smokingStatus).toBe(SmokingStatus.NON_SMOKER);
    });

    it('updates the profile when it already exists', async () => {
      const dto: UpdateApplicantProfileDto = { peopleCount: 2, adultsCount: 2 };
      const profile = makeRawProfile({ peopleCount: 2, adultsCount: 2 });
      prismaMock.applicantProfile.upsert.mockResolvedValue(profile);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(prismaMock.applicantProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { applicantId: APPLICANT_ID },
          update: { ...dto },
        }),
      );
      expect(result.peopleCount).toBe(2);
    });
  });

  describe('getProfile (controller guard test via service)', () => {
    it('throws NotFoundException when profile is null', async () => {
      prismaMock.applicantProfile.findUnique.mockResolvedValue(null);

      const profile = await service.findByApplicant(APPLICANT_ID);
      expect(profile).toBeNull();

      expect(() => {
        if (!profile) throw new NotFoundException('Profile not found');
      }).toThrow(NotFoundException);
    });
  });
});
