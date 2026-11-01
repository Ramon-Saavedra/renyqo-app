import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile, Listing } from '../generated/prisma/client';
import {
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000001';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000002';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000003';

const makeListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: LISTING_ID,
  providerId: PROVIDER_ID,
  status: ListingStatus.PUBLISHED,
  city: 'Berlin',
  zip: '10115',
  street: 'Main Street 1',
  district: null,
  country: 'DE',
  showExactAddress: false,
  objectType: ObjectType.APARTMENT,
  livingArea: 60,
  rooms: 2,
  bedrooms: 1,
  coldRent: 1000,
  additionalCosts: 200,
  deposit: 2000,
  depositMonths: 2,
  availableFrom: new Date('2024-01-01'),
  title: 'Test Listing',
  shortDescription: null,
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  displayOrder: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: new Date('2024-01-01'),
  rentedAt: null,
  ...overrides,
});

const makeProfile = (
  overrides: Partial<ApplicantProfile> = {},
): ApplicantProfile => ({
  id: '00000000-0000-4000-8000-000000000004',
  applicantId: APPLICANT_ID,
  introduction: null,
  householdNetIncome: 4000,
  incomeProofAvailable: true,
  schufaAvailable: true,
  peopleCount: 2,
  adultsCount: 2,
  childrenCount: 0,
  hasPets: false,
  isSmoker: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('EligibilityService canonical contract', () => {
  const listing = {
    findUnique: jest.fn<(args: unknown) => Promise<Listing | null>>(),
  };
  const applicantProfile = {
    findUnique: jest.fn<(args: unknown) => Promise<ApplicantProfile | null>>(),
  };
  const service = new EligibilityService({
    listing,
    applicantProfile,
  } as unknown as PrismaService);
  beforeEach(() => {
    jest.clearAllMocks();
    listing.findUnique.mockResolvedValue(makeListing());
    applicantProfile.findUnique.mockResolvedValue(makeProfile());
  });

  it('reads current server facts and returns typed checks without writes', async () => {
    listing.findUnique.mockResolvedValue(
      makeListing({ minimumHouseholdNetIncome: 5000 }),
    );
    const result = await service.check(LISTING_ID, APPLICANT_ID);
    expect(result).toMatchObject({
      canApply: false,
      result: 'NO_MATCH',
      reasons: ['household_income_below_requirement'],
    });
    expect(result.checks).toHaveLength(7);
    expect(applicantProfile.findUnique).toHaveBeenCalledWith({
      where: { applicantId: APPLICANT_ID },
    });
    expect(result.facts.householdNetIncome).toBe(4000);
  });
  it('requires an existing published listing', async () => {
    listing.findUnique.mockResolvedValue(null);
    await expect(service.check(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
      NotFoundException,
    );
    listing.findUnique.mockResolvedValue(
      makeListing({ status: ListingStatus.DRAFT }),
    );
    await expect(service.check(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });
  it.each([
    ['no requirements', {}, {}, 'MATCH', true],
    [
      'exact boundaries',
      { minimumHouseholdNetIncome: 4000, suitableForPeopleCount: 2 },
      {},
      'MATCH',
      true,
    ],
    [
      'below income',
      { minimumHouseholdNetIncome: 4001 },
      {},
      'NO_MATCH',
      false,
    ],
    ['too many people', { suitableForPeopleCount: 1 }, {}, 'NO_MATCH', false],
    [
      'missing income',
      { minimumHouseholdNetIncome: 1 },
      { householdNetIncome: null },
      'INSUFFICIENT_INFORMATION',
      false,
    ],
    [
      'missing household',
      { suitableForPeopleCount: 2 },
      { adultsCount: null, childrenCount: null, peopleCount: null },
      'INSUFFICIENT_INFORMATION',
      false,
    ],
    [
      'legacy household fallback',
      { suitableForPeopleCount: 2 },
      { adultsCount: null, childrenCount: null, peopleCount: 3 },
      'NO_MATCH',
      false,
    ],
    [
      'pets prohibited',
      { petsPolicy: PetsPolicy.NOT_ALLOWED },
      { hasPets: true },
      'NO_MATCH',
      false,
    ],
    [
      'missing pets',
      { petsPolicy: PetsPolicy.NOT_ALLOWED },
      { hasPets: null },
      'INSUFFICIENT_INFORMATION',
      false,
    ],
    [
      'smoking prohibited',
      { smokingPolicy: SmokingPolicy.NOT_ALLOWED },
      { isSmoker: true },
      'NO_MATCH',
      false,
    ],
    [
      'missing smoking',
      { smokingPolicy: SmokingPolicy.NOT_ALLOWED },
      { isSmoker: null },
      'INSUFFICIENT_INFORMATION',
      false,
    ],
    [
      'pets arrangement',
      { petsPolicy: PetsPolicy.BY_ARRANGEMENT },
      { hasPets: true },
      'MATCH_WITH_OBSERVATIONS',
      true,
    ],
    [
      'unknown arrangement',
      { smokingPolicy: SmokingPolicy.BY_ARRANGEMENT },
      { isSmoker: null },
      'MATCH_WITH_OBSERVATIONS',
      true,
    ],
    [
      'declarations pending',
      { schufaRequired: true, incomeProofRequired: true },
      { schufaAvailable: false, incomeProofAvailable: null },
      'MATCH_WITH_OBSERVATIONS',
      true,
    ],
    [
      'declarations unverified',
      { schufaRequired: true, incomeProofRequired: true },
      {},
      'MATCH_WITH_OBSERVATIONS',
      true,
    ],
    [
      'irrelevant missing facts',
      {},
      { householdNetIncome: null, hasPets: null, isSmoker: null },
      'MATCH',
      true,
    ],
  ] as const)('%s', (_name, criteria, facts, result, canApply) => {
    const evaluated = service.evaluate(
      makeListing(criteria),
      makeProfile(facts),
    );
    expect(evaluated.result).toBe(result);
    expect(evaluated.canApply).toBe(canApply);
    expect(evaluated.checks).toHaveLength(7);
    expect(
      service.evaluateCriteria(makeListing(criteria), makeProfile(facts)),
    ).toMatchObject({
      result,
      canApply,
      checks: evaluated.checks,
      facts: evaluated.facts,
    });
  });
  it('does not equate a nonexistent profile with an evaluated profile', () => {
    expect(service.evaluate(makeListing(), null)).toMatchObject({
      result: 'INSUFFICIENT_INFORMATION',
      canApply: false,
      reasons: ['profile_not_available'],
    });
    expect(service.buildHardMatchWhere(null).AND).toContainEqual({
      id: { in: [] },
    });
  });
  it('records only facts used by configured rules', () => {
    expect(service.evaluate(makeListing(), makeProfile()).facts).toEqual({
      profilePresent: true,
      householdNetIncome: null,
      householdSize: null,
      hasPets: null,
      isSmoker: null,
      schufaAvailable: null,
      incomeProofAvailable: null,
    });
    const result = service.evaluate(
      makeListing({ schufaRequired: true }),
      makeProfile(),
    );
    expect(result.warnings).toEqual(['schufa_declared_not_verified']);
    expect(
      result.checks.find((c) => c.criterion === 'SCHUFA_DECLARATION')?.outcome,
    ).toBe('OBSERVATION');
  });
  it('SQL only filters hard rules and treats unknown policy facts conservatively', () => {
    const where = service.buildHardMatchWhere(
      makeProfile({
        hasPets: null,
        isSmoker: true,
        householdNetIncome: null,
        peopleCount: null,
        adultsCount: null,
        childrenCount: null,
      }),
    );
    expect(where.AND).toEqual([
      {},
      { minimumHouseholdNetIncome: null },
      { suitableForPeopleCount: null },
      { OR: [{ petsPolicy: null }, { petsPolicy: { not: 'NOT_ALLOWED' } }] },
      {
        OR: [
          { smokingPolicy: null },
          { smokingPolicy: { not: 'NOT_ALLOWED' } },
        ],
      },
      {},
      {},
    ]);
    expect(
      service.buildHardMatchWhere(
        makeProfile({ schufaAvailable: false, incomeProofAvailable: false }),
      ),
    ).toEqual(service.buildHardMatchWhere(makeProfile()));
  });
  it('onboarding completeness does not require document declarations', () => {
    expect(
      service.isProfileComplete(
        makeProfile({ schufaAvailable: null, incomeProofAvailable: null }),
      ),
    ).toBe(true);
    expect(service.isProfileComplete(makeProfile({ hasPets: null }))).toBe(
      false,
    );
  });
});
