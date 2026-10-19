import { Test } from '@nestjs/testing';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ObjectType,
  PetsPolicy,
  Role,
  SmokingPolicy,
  UserStatus,
} from '../generated/prisma/enums';
import { ApplicationProcessQueryService } from '../applications/application-process-query.service';
import { ApplicationsService } from '../applications/applications.service';
import { ApplicantListingAttentionEnricher } from '../application-attention/applicant-listing-attention.enricher';
import { ApplicationAttentionQueryService } from '../application-attention/application-attention-query.service';
import {
  ApplicationAttentionListItemDto,
  ApplicationAttentionSummaryDto,
  AttentionCategoryTotalsDto,
} from '../application-attention/dto/attention-response.dto';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SafeUser } from '../users/types/safe-user.type';
import type { ApplicantListingSummaryBuildSource } from './applicant-listing-summary-listing.select';
import { ApplicantListingSummaryService } from './applicant-listing-summary.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000099';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const HIGHER_APPLICATION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const LOWER_APPLICATION_ID = '00000000-0000-4000-8000-000000000001';

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

const listing: ApplicantListingSummaryBuildSource = {
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
  images: [],
};

describe('newest blocking application selection', () => {
  it('uses the same application for listing status and attention when timestamps match', async () => {
    const createdAt = new Date('2026-10-16T12:00:00.000Z');
    const findMany = jest.fn().mockResolvedValue([
      {
        id: HIGHER_APPLICATION_ID,
        listingId: LISTING_ID,
        status: ApplicationStatus.REJECTED,
        publicReason: ApplicationRejectionReason.NOT_SELECTED,
        createdAt,
      },
      {
        id: LOWER_APPLICATION_ID,
        listingId: LISTING_ID,
        status: ApplicationStatus.ACTIVE,
        publicReason: null,
        createdAt,
      },
    ]);
    const query = new ApplicationProcessQueryService(
      { application: { findMany } } as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    const batch = jest.fn().mockResolvedValue({
      items: [
        new ApplicationAttentionListItemDto(
          HIGHER_APPLICATION_ID,
          LISTING_ID,
          'Listing title',
          'Leipzig',
          new ApplicationAttentionSummaryDto(
            0,
            0,
            new AttentionCategoryTotalsDto(0, 0, 0),
            [],
            [],
            null,
          ),
        ),
      ],
    });
    const module = await Test.createTestingModule({
      providers: [
        ApplicantListingSummaryService,
        ApplicantListingAttentionEnricher,
        {
          provide: PrismaService,
          useValue: {
            applicantProfile: {
              findUnique: jest.fn().mockResolvedValue(null),
            },
          },
        },
        {
          provide: ApplicationsService,
          useValue: {
            findBlockingApplicationsForListings:
              query.findBlockingApplicationsForListings.bind(query),
            findAdmissionForListings: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: ApplicationAttentionQueryService,
          useValue: { batch },
        },
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

    const [card] = await module
      .get(ApplicantListingSummaryService)
      .buildSummaries(applicantUser, [listing], {
        isSavedByListingId: new Set(),
      });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(card.applicationStatus).toBe(ApplicationStatus.REJECTED);
    expect(card.publicReason).toBe(ApplicationRejectionReason.NOT_SELECTED);
    expect(card.applicationAttention?.applicationId).toBe(
      HIGHER_APPLICATION_ID,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(APPLICANT_ID, 'applicant', [
      HIGHER_APPLICATION_ID,
    ]);
  });
});
