import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile, Listing } from '../generated/prisma/client';
import {
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
  SmokingStatus,
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
  householdNetIncome: 4000,
  incomeProofAvailable: true,
  schufaAvailable: true,
  peopleCount: 2,
  adultsCount: 2,
  childrenCount: 0,
  hasPets: false,
  petsNote: null,
  smokingStatus: SmokingStatus.NON_SMOKER,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('EligibilityService', () => {
  let service: EligibilityService;
  let prismaMock: {
    listing: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<Listing | null>
      >;
    };
    applicantProfile: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicantProfile | null>
      >;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      listing: {
        findUnique: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
      },
      applicantProfile: {
        findUnique:
          jest.fn<(args?: unknown) => Promise<ApplicantProfile | null>>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EligibilityService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<EligibilityService>(EligibilityService);
  });

  it('allows an applicant when no requirements are selected', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(makeListing());
    prismaMock.applicantProfile.findUnique.mockResolvedValue(null);

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: true,
      reasons: [],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('returns blocking reasons for unmet hard requirements', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        minimumHouseholdNetIncome: 5000,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: 2,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({
        householdNetIncome: 3000,
        schufaAvailable: false,
        incomeProofAvailable: false,
        adultsCount: 2,
        childrenCount: 1,
      }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: false,
      reasons: [
        'household_income_below_requirement',
        'schufa_required_but_not_available',
        'income_proof_required_but_not_available',
        'household_size_exceeds_requirement',
      ],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('blocks missing applicant data for selected hard requirements', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        minimumHouseholdNetIncome: 3000,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: 2,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(null);

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: false,
      reasons: [
        'household_income_not_available',
        'schufa_required_but_not_available',
        'income_proof_required_but_not_available',
        'household_size_not_available',
      ],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('allows exact income and household-size boundaries', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        minimumHouseholdNetIncome: 4000,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: 2,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(makeProfile());

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: true,
      reasons: [],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('returns warnings without blocking for preference policies', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        petsPolicy: PetsPolicy.BY_ARRANGEMENT,
        smokingPolicy: SmokingPolicy.NON_SMOKERS_PREFERRED,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({
        hasPets: true,
        smokingStatus: SmokingStatus.SMOKER,
      }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: true,
      reasons: [],
      warnings: ['pets_by_arrangement', 'smoking_not_preferred'],
      evaluatedAt: expect.any(Date),
    });
  });

  it('returns the remaining preference warnings without blocking', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        petsPolicy: PetsPolicy.PREFER_NOT,
        smokingPolicy: SmokingPolicy.BY_ARRANGEMENT,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({
        hasPets: true,
        smokingStatus: SmokingStatus.OCCASIONALLY,
      }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: true,
      reasons: [],
      warnings: ['pets_not_preferred', 'smoking_by_arrangement'],
      evaluatedAt: expect.any(Date),
    });
  });

  it('does not warn for allowed policies or a non-smoking applicant', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({
        petsPolicy: PetsPolicy.ALLOWED,
        smokingPolicy: SmokingPolicy.ALLOWED,
      }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({ hasPets: true, smokingStatus: SmokingStatus.NON_SMOKER }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: true,
      reasons: [],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('uses peopleCount when the detailed household counts are unavailable', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({ suitableForPeopleCount: 2 }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({ peopleCount: 3, adultsCount: null, childrenCount: null }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).resolves.toEqual({
      canApply: false,
      reasons: ['household_size_exceeds_requirement'],
      warnings: [],
      evaluatedAt: expect.any(Date),
    });
  });

  it('performs no database mutation while evaluating eligibility', async () => {
    const accessedMethods = new Set<string>();
    const readOnlyDelegate = <T>(result: T) =>
      new Proxy(
        { findUnique: jest.fn(() => Promise.resolve(result)) },
        {
          get(target, property) {
            if (typeof property === 'string') {
              accessedMethods.add(property);
            }
            return Reflect.get(target, property) as unknown;
          },
        },
      );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EligibilityService,
        {
          provide: PrismaService,
          useValue: {
            listing: readOnlyDelegate(
              makeListing({ minimumHouseholdNetIncome: 5000 }),
            ),
            applicantProfile: readOnlyDelegate(
              makeProfile({ householdNetIncome: 1000 }),
            ),
          },
        },
      ],
    }).compile();

    await module
      .get<EligibilityService>(EligibilityService)
      .check(LISTING_ID, APPLICANT_ID);

    expect([...accessedMethods]).toEqual(['findUnique']);
  });

  it('reads the applicant profile from the database instead of client input', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({ minimumHouseholdNetIncome: 5000 }),
    );
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeProfile({ householdNetIncome: 1000 }),
    );

    await expect(
      service.check(LISTING_ID, APPLICANT_ID),
    ).resolves.toMatchObject({
      canApply: false,
      reasons: ['household_income_below_requirement'],
    });
    expect(prismaMock.applicantProfile.findUnique).toHaveBeenCalledWith({
      where: { applicantId: APPLICANT_ID },
    });
  });

  it('throws when the listing does not exist', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(null);

    await expect(service.check(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws when the listing is not published', async () => {
    prismaMock.listing.findUnique.mockResolvedValue(
      makeListing({ status: ListingStatus.DRAFT }),
    );

    await expect(service.check(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });
});
