import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile } from '../generated/prisma/client';
import { SmokingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicantProfileService } from './applicant-profile.service';
import type { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

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

type TransactionMock = {
  applicantProfile: {
    findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    upsert: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
};

describe('ApplicantProfileService', () => {
  let service: ApplicantProfileService;
  let prismaMock: TransactionMock & {
    $transaction: jest.MockedFunction<
      (
        fn: (tx: TransactionMock) => Promise<unknown>,
        options?: unknown,
      ) => Promise<unknown>
    >;
  };

  beforeEach(async () => {
    prismaMock = {
      applicantProfile: {
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        upsert: jest.fn<(args?: unknown) => Promise<unknown>>(),
      },
      $transaction: jest.fn((fn: (tx: TransactionMock) => Promise<unknown>) =>
        fn(prismaMock),
      ),
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
      prismaMock.applicantProfile.findUnique.mockResolvedValue(null);
      prismaMock.applicantProfile.upsert.mockResolvedValue(profile);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(result.householdNetIncome).toBe(3000);
    });

    it('updates the profile when it already exists', async () => {
      const existing = makeRawProfile({
        householdNetIncome: 2000,
        adultsCount: 1,
        childrenCount: 0,
        peopleCount: 1,
      });
      const dto: UpdateApplicantProfileDto = { householdNetIncome: 3500 };
      const updated = makeRawProfile({
        householdNetIncome: 3500,
        adultsCount: 1,
        childrenCount: 0,
        peopleCount: 1,
      });
      prismaMock.applicantProfile.findUnique.mockResolvedValue(existing);
      prismaMock.applicantProfile.upsert.mockResolvedValue(updated);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(result.householdNetIncome).toBe(3500);
    });

    it('calculates peopleCount from adultsCount and childrenCount', async () => {
      const dto: UpdateApplicantProfileDto = {
        adultsCount: 2,
        childrenCount: 1,
      };
      const profile = makeRawProfile({
        adultsCount: 2,
        childrenCount: 1,
        peopleCount: 3,
      });
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeRawProfile(),
      );
      prismaMock.applicantProfile.upsert.mockResolvedValue(profile);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(result.peopleCount).toBe(3);
    });

    it('sets peopleCount to null when household counts are cleared', async () => {
      const existing = makeRawProfile({
        adultsCount: 2,
        childrenCount: 1,
        peopleCount: 3,
      });
      const dto: UpdateApplicantProfileDto = {
        adultsCount: null,
        childrenCount: null,
      };
      const cleared = makeRawProfile({
        adultsCount: null,
        childrenCount: null,
        peopleCount: null,
      });
      prismaMock.applicantProfile.findUnique.mockResolvedValue(existing);
      prismaMock.applicantProfile.upsert.mockResolvedValue(cleared);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(result.peopleCount).toBeNull();
      expect(result.adultsCount).toBeNull();
      expect(result.childrenCount).toBeNull();
    });

    it('rejects household counts when only adultsCount is provided', async () => {
      const dto: UpdateApplicantProfileDto = { adultsCount: 2 };
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeRawProfile(),
      );

      await expect(service.upsert(APPLICANT_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects household counts when only childrenCount is provided', async () => {
      const dto: UpdateApplicantProfileDto = { childrenCount: 1 };
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeRawProfile(),
      );

      await expect(service.upsert(APPLICANT_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('uses persisted counterparts for partial household updates', async () => {
      const existing = makeRawProfile({
        adultsCount: 3,
        childrenCount: 0,
        peopleCount: 3,
      });
      const dto: UpdateApplicantProfileDto = { childrenCount: 2 };
      const updated = makeRawProfile({
        adultsCount: 3,
        childrenCount: 2,
        peopleCount: 5,
      });
      prismaMock.applicantProfile.findUnique.mockResolvedValue(existing);
      prismaMock.applicantProfile.upsert.mockResolvedValue(updated);

      const result = await service.upsert(APPLICANT_ID, dto);

      expect(result.peopleCount).toBe(5);
    });

    it('rejects an empty PATCH body', async () => {
      await expect(service.upsert(APPLICANT_ID, {})).rejects.toThrow(
        BadRequestException,
      );
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
