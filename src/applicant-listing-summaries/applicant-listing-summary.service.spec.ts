import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicantProfile } from '../generated/prisma/client';
import {
  ApplicationStatus,
  ObjectType,
  PetsPolicy,
  Role,
  SmokingPolicy,
  UserStatus,
} from '../generated/prisma/enums';
import { ApplicationsService } from '../applications/applications.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileMatch } from '../listings/dto/applicant-listing-profile-match.enum';
import type { ApplicantListingSummaryBuildSource } from './applicant-listing-summary-listing.select';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingSummaryService } from './applicant-listing-summary.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000099';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_LISTING_ID = '00000000-0000-4000-8000-000000000003';

const applicantUser: SafeUser = {
  id: APPLICANT_ID,
  name: 'Test',
  email: 'test@test.com',
  role: Role.APPLICANT,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const makeListing = (
  overrides: Partial<ApplicantListingSummaryBuildSource> = {},
): ApplicantListingSummaryBuildSource => ({
  id: LISTING_ID,
  title: 'Test Listing',
  city: 'Berlin',
  zip: '10115',
  district: null,
  objectType: ObjectType.APARTMENT,
  livingArea: 62.5,
  rooms: 2,
  bedrooms: 1,
  coldRent: 1200,
  additionalCosts: 250,
  deposit: 2400,
  depositMonths: 2,
  availableFrom: new Date('2026-09-01'),
  shortDescription: 'Nice place',
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  publishedAt: new Date('2026-07-01'),
  petsPolicy: PetsPolicy.ALLOWED,
  smokingPolicy: SmokingPolicy.NOT_ALLOWED,
  images: [
    { secureUrl: 'https://example.com/cover.jpg', position: 0, isCover: true },
  ],
  ...overrides,
});

const makeApplicantProfile = (): ApplicantProfile =>
  ({
    applicantId: APPLICANT_ID,
    householdNetIncome: 5000,
    incomeProofAvailable: true,
    schufaAvailable: true,
    peopleCount: 2,
    adultsCount: 2,
    childrenCount: 0,
    hasPets: false,
    isSmoker: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  }) as ApplicantProfile;

describe('ApplicantListingSummaryService', () => {
  let service: ApplicantListingSummaryService;
  let prismaMock: {
    applicantProfile: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicantProfile | null>
      >;
    };
  };
  let applicationsMock: jest.Mocked<
    Pick<ApplicationsService, 'findBlockingApplicationsForListings'>
  >;
  let eligibilityMock: jest.Mocked<EligibilityService>;

  beforeEach(async () => {
    prismaMock = {
      applicantProfile: {
        findUnique: jest
          .fn<(args?: unknown) => Promise<ApplicantProfile | null>>()
          .mockResolvedValue(null),
      },
    };

    applicationsMock = {
      findBlockingApplicationsForListings: jest
        .fn<
          (
            applicantId: string,
            listingIds: readonly string[],
          ) => Promise<
            ReadonlyMap<
              string,
              import('../applications/applicant-listing-application-state').BlockingApplicationState
            >
          >
        >()
        .mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicantListingSummaryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ApplicationsService, useValue: applicationsMock },
        {
          provide: EligibilityService,
          useValue: {
            isProfileComplete: jest.fn().mockReturnValue(false),
            evaluateCriteria: jest.fn().mockReturnValue({
              canApply: false,
              reasons: [],
              warnings: [],
              evaluatedAt: new Date(),
            }),
          },
        },
      ],
    }).compile();

    service = module.get(ApplicantListingSummaryService);
    eligibilityMock = module.get(EligibilityService);
  });

  it('returns an empty array for no listings', async () => {
    const result = await service.buildSummaries(applicantUser, [], {
      isSavedByListingId: new Set(),
    });

    expect(result).toEqual([]);
    expect(prismaMock.applicantProfile.findUnique).not.toHaveBeenCalled();
  });

  it('marks isSaved from the provided set', async () => {
    const listings = [
      makeListing(),
      makeListing({ id: OTHER_LISTING_ID, title: 'Other' }),
    ];

    const result = await service.buildSummaries(applicantUser, listings, {
      isSavedByListingId: new Set([LISTING_ID]),
    });

    expect(result[0].isSaved).toBe(true);
    expect(result[1].isSaved).toBe(false);
  });

  it('returns UNKNOWN profileMatch for anonymous users', async () => {
    const result = await service.buildSummaries(null, [makeListing()], {
      isSavedByListingId: new Set(),
    });

    expect(result[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
    expect(result[0].hasApplied).toBe(false);
    expect(
      applicationsMock.findBlockingApplicationsForListings,
    ).not.toHaveBeenCalled();
  });

  it('returns PROFILE_INCOMPLETE for applicants without a complete profile', async () => {
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeApplicantProfile(),
    );
    eligibilityMock.isProfileComplete.mockReturnValue(false);

    const result = await service.buildSummaries(
      applicantUser,
      [makeListing()],
      {
        isSavedByListingId: new Set([LISTING_ID]),
      },
    );

    expect(result[0].profileMatch).toBe(ProfileMatch.PROFILE_INCOMPLETE);
    expect(result[0].isSaved).toBe(true);
  });

  it('returns MATCH when eligibility passes', async () => {
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeApplicantProfile(),
    );
    eligibilityMock.isProfileComplete.mockReturnValue(true);
    eligibilityMock.evaluateCriteria.mockReturnValue({
      canApply: true,
      reasons: [],
      warnings: [],
      evaluatedAt: new Date(),
    });

    const result = await service.buildSummaries(
      applicantUser,
      [makeListing()],
      {
        isSavedByListingId: new Set(),
      },
    );

    expect(result[0].profileMatch).toBe(ProfileMatch.MATCH);
  });

  it('returns NO_MATCH when eligibility fails', async () => {
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeApplicantProfile(),
    );
    eligibilityMock.isProfileComplete.mockReturnValue(true);
    eligibilityMock.evaluateCriteria.mockReturnValue({
      canApply: false,
      reasons: [],
      warnings: [],
      evaluatedAt: new Date(),
    });

    const result = await service.buildSummaries(
      applicantUser,
      [makeListing()],
      {
        isSavedByListingId: new Set(),
      },
    );

    expect(result[0].profileMatch).toBe(ProfileMatch.NO_MATCH);
  });

  it('uses a preloaded applicant profile without querying prisma', async () => {
    const profile = makeApplicantProfile();
    eligibilityMock.isProfileComplete.mockReturnValue(true);
    eligibilityMock.evaluateCriteria.mockReturnValue({
      canApply: true,
      reasons: [],
      warnings: [],
      evaluatedAt: new Date(),
    });

    const result = await service.buildSummaries(
      applicantUser,
      [makeListing()],
      {
        isSavedByListingId: new Set(),
        applicantProfile: profile,
      },
    );

    expect(result[0].profileMatch).toBe(ProfileMatch.MATCH);
    expect(prismaMock.applicantProfile.findUnique).not.toHaveBeenCalled();
  });

  it('exposes blocking application state in batch', async () => {
    prismaMock.applicantProfile.findUnique.mockResolvedValue(
      makeApplicantProfile(),
    );
    applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
      new Map([
        [
          LISTING_ID,
          {
            status: ApplicationStatus.ACTIVE,
            publicReason: null,
          },
        ],
      ]),
    );

    const result = await service.buildSummaries(
      applicantUser,
      [makeListing()],
      {
        isSavedByListingId: new Set([LISTING_ID]),
      },
    );

    expect(result[0].hasApplied).toBe(true);
    expect(result[0].applicationStatus).toBe(ApplicationStatus.ACTIVE);
    expect(result[0].publicReason).toBeNull();
    expect(result[0].isSaved).toBe(true);
  });
});
