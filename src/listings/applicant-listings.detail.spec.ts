import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import type { UploadApiResponse } from 'cloudinary';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type {
  ApplicantProfile,
  Listing,
  ListingImage,
} from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
  ObjectType,
  PetsPolicy,
  Role,
  SmokingPolicy,
  UserStatus,
} from '../generated/prisma/enums';
import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
import { SavedListingsService } from '../saved-listings/saved-listings.service';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import { ApplicationsService } from '../applications/applications.service';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { ProfileMatch } from './dto/applicant-listing-profile-match.enum';
import { PublicProviderType } from '../auth/dto/register.dto';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingsService } from './applicant-listings.service';
import { ApplicantListingDiscoveryQuery } from './applicant-listing-discovery-query';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';

function serialized<T>(value: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const CLOUDINARY_FOLDER = 'renyqo';

type ListingsTransactionMock = {
  listing: {
    create: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    findFirst: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<Listing | null>
    >;
    update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
    aggregate: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  listingImage: {
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
  };
  application: {
    findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    updateMany: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    update: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  $queryRaw: jest.MockedFunction<(query: unknown) => Promise<unknown>>;
};

type PrismaTransactionRunner = (
  fn: (tx: ListingsTransactionMock) => Promise<unknown>,
) => Promise<unknown>;

type PrismaMock = ListingsTransactionMock & {
  $transaction: jest.MockedFunction<PrismaTransactionRunner>;
  applicantProfile: {
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<ApplicantProfile | null>
    >;
  };
};

type DiscoveryListing = {
  id: string;
  title: string | null;
  city: string | null;
  zip: string | null;
  district: string | null;
  objectType: string | null;
  livingArea: number | null;
  rooms: number | null;
  bedrooms: number | null;
  coldRent: number | null;
  additionalCosts: number | null;
  deposit: number | null;
  depositMonths: number | null;
  availableFrom: Date | null;
  shortDescription: string | null;
  publishedAt: Date | null;
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean;
  incomeProofRequired: boolean;
  suitableForPeopleCount: number | null;
  petsPolicy: string | null;
  smokingPolicy: string | null;
  images: { secureUrl: string; position: number; isCover: boolean }[];
};

type DiscoveryDetail = DiscoveryListing & {
  district: string | null;
  street: string | null;
  showExactAddress: boolean;
  minimumHouseholdNetIncome: number | null;
  schufaRequired: boolean;
  incomeProofRequired: boolean;
  suitableForPeopleCount: number | null;
  petsPolicy: string | null;
  smokingPolicy: string | null;
};

const makeDiscoveryListing = (
  overrides: Partial<DiscoveryListing> = {},
): DiscoveryListing => ({
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
  publishedAt: new Date('2026-07-01'),
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  images: [
    { secureUrl: 'https://example.com/cover.jpg', position: 0, isCover: true },
  ],
  ...overrides,
});

const makeDiscoveryDetail = (
  overrides: Partial<DiscoveryDetail> = {},
): DiscoveryDetail => ({
  ...makeDiscoveryListing(),
  district: 'Mitte',
  street: 'Hauptstrasse 1',
  showExactAddress: false,
  minimumHouseholdNetIncome: 3000,
  schufaRequired: true,
  incomeProofRequired: false,
  suitableForPeopleCount: 2,
  petsPolicy: PetsPolicy.ALLOWED,
  smokingPolicy: SmokingPolicy.NOT_ALLOWED,
  ...overrides,
});

describe('ApplicantListingsService', () => {
  let service: ApplicantListingsService;
  let prismaMock: PrismaMock;
  let cloudinaryMock: jest.Mocked<
    Pick<CloudinaryService, 'uploadBuffer' | 'deleteByPublicId'>
  >;
  let eligibilityMock: jest.Mocked<EligibilityService>;
  let applicationsMock: jest.Mocked<
    Pick<
      ApplicationsService,
      | 'findBlockingApplicationsForListings'
      | 'findBlockingApplicationForListing'
      | 'findAdmissionForListings'
    >
  >;
  let savedListingsMock: jest.Mocked<
    Pick<
      SavedListingsService,
      'findSavedListingIdsForListings' | 'isListingSaved'
    >
  >;
  let publishedListingsMock: jest.Mocked<
    Pick<
      PublishedListingsService,
      'getPublicAccessWhere' | 'getPublicAccessWhereFragments'
    >
  >;

  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = (fn) =>
      Promise.resolve(fn(prismaMock));

    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findUnique: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest
          .fn<(args?: unknown) => Promise<number>>()
          .mockResolvedValue(0),
        aggregate: jest
          .fn<(args?: unknown) => Promise<unknown>>()
          .mockResolvedValue({ _max: { displayOrder: 0 } }),
      },
      listingImage: {
        create: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
      },
      application: {
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        updateMany: jest.fn<(args?: unknown) => Promise<unknown>>(),
        update: jest.fn<(args?: unknown) => Promise<unknown>>(),
      },
      $queryRaw: jest.fn<(query: unknown) => Promise<unknown>>(),
      $transaction: jest.fn<PrismaTransactionRunner>(transactionRunner),
      applicantProfile: {
        findUnique: jest
          .fn<(args?: unknown) => Promise<ApplicantProfile | null>>()
          .mockResolvedValue(null),
      },
    };

    cloudinaryMock = {
      uploadBuffer:
        jest.fn<
          (buffer: Buffer, folder: string) => Promise<UploadApiResponse>
        >(),
      deleteByPublicId: jest.fn<(publicId: string) => Promise<void>>(),
    };

    applicationsMock = {
      findAdmissionForListings: jest
        .fn<ApplicationsService['findAdmissionForListings']>()
        .mockResolvedValue(new Map()),
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
      findBlockingApplicationForListing: jest
        .fn<
          (
            applicantId: string,
            listingId: string,
          ) => Promise<
            | import('../applications/applicant-listing-application-state').BlockingApplicationState
            | undefined
          >
        >()
        .mockResolvedValue(undefined),
    };

    savedListingsMock = {
      findSavedListingIdsForListings: jest
        .fn<
          (
            applicantId: string,
            listingIds: readonly string[],
          ) => Promise<ReadonlySet<string>>
        >()
        .mockResolvedValue(new Set()),
      isListingSaved: jest
        .fn<(applicantId: string, listingId: string) => Promise<boolean>>()
        .mockResolvedValue(false),
    };

    publishedListingsMock = {
      getPublicAccessWhere: jest
        .fn<
          () => import('../generated/prisma/client').Prisma.ListingWhereInput
        >()
        .mockReturnValue({
          status: ListingStatus.PUBLISHED,
          publishedAt: { not: null },
        }),
      getPublicAccessWhereFragments: jest
        .fn<
          () => readonly import('../generated/prisma/client').Prisma.ListingWhereInput[]
        >()
        .mockReturnValue([
          { status: ListingStatus.PUBLISHED },
          { publishedAt: { not: null } },
        ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicantListingsService,
        {
          provide: ListingOrderingService,
          useValue: {
            getNextDisplayOrder: jest.fn(() => Promise.resolve(1)),
            move: jest.fn(),
          },
        },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: CloudinaryService,
          useValue: cloudinaryMock,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
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
            buildHardMatchWhere: jest.fn().mockReturnValue({}),
          },
        },
        {
          provide: ApplicationsService,
          useValue: applicationsMock,
        },
        {
          provide: SavedListingsService,
          useValue: savedListingsMock,
        },
        {
          provide: PublishedListingsService,
          useValue: publishedListingsMock,
        },
        ApplicantListingSummaryService,
        ListingInputRules,
        ListingResponseMapper,
        ApplicantListingDiscoveryQuery,
      ],
    }).compile();

    service = module.get<ApplicantListingsService>(ApplicantListingsService);
    eligibilityMock = module.get(EligibilityService);
  });
  describe('findPublishedDetailForApplicant', () => {
    const discoveryDetail = makeDiscoveryDetail();

    it('returns a published listing detail', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.id).toBe(LISTING_ID);
      expect(result.title).toBe('Test Listing');
    });

    it('hides street when showExactAddress is false', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeDiscoveryDetail({
          showExactAddress: false,
          street: 'Hauptstrasse 1',
        }),
      );

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.street).toBeNull();
    });

    it('shows street when showExactAddress is true', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(
        makeDiscoveryDetail({
          showExactAddress: true,
          street: 'Hauptstrasse 1',
        }),
      );

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.street).toBe('Hauptstrasse 1');
    });

    it('includes public application requirements', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      expect(result.requirements.minimumHouseholdNetIncome).toBe(3000);
      expect(result.requirements.schufaRequired).toBe(true);
      expect(result.requirements.incomeProofRequired).toBe(false);
      expect(result.requirements.suitableForPeopleCount).toBe(2);
    });

    it('returns 404 for non-published listing', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findPublishedDetailForApplicant(LISTING_ID, null),
      ).rejects.toThrow(NotFoundException);
    });

    it('never exposes showExactAddress flag', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      expect(serialized_).not.toHaveProperty('showExactAddress');
    });

    it('never exposes providerId', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      expect(serialized_).not.toHaveProperty('providerId');
    });

    it('includes images without publicId', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

      const result = await service.findPublishedDetailForApplicant(
        LISTING_ID,
        null,
      );

      const serialized_ = serialized(result);
      const images = serialized_.images as Record<string, unknown>[];
      for (const image of images) {
        expect(image).not.toHaveProperty('publicId');
        expect(image.secureUrl).toBeDefined();
      }
    });

    describe('profile match', () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
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

      const providerUser: SafeUser = {
        ...applicantUser,
        id: '00000000-0000-4000-8000-000000000098',
        role: Role.PROVIDER,
        providerType: PublicProviderType.PRIVATE,
      };

      it('null user returns UNKNOWN', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          null,
        );

        expect(result.profileMatch).toBe(ProfileMatch.UNKNOWN);
      });

      it('provider user returns UNKNOWN', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          providerUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.UNKNOWN);
      });

      it('applicant with incomplete profile returns PROFILE_INCOMPLETE', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(false);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.PROFILE_INCOMPLETE);
      });

      it('applicant with complete profile returns MATCH when eligible', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(true);
        eligibilityMock.evaluateCriteria.mockReturnValue({
          canApply: true,
          reasons: [],
          warnings: [],
          evaluatedAt: new Date(),
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.MATCH);
      });

      it('applicant with complete profile returns NO_MATCH when ineligible', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        eligibilityMock.isProfileComplete.mockReturnValue(true);
        eligibilityMock.evaluateCriteria.mockReturnValue({
          canApply: false,
          reasons: [],
          warnings: [],
          evaluatedAt: new Date(),
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.profileMatch).toBe(ProfileMatch.NO_MATCH);
      });
    });

    describe('application state', () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
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

      it('returns empty application state for anonymous callers', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          null,
        );

        expect(
          applicationsMock.findBlockingApplicationForListing,
        ).not.toHaveBeenCalled();
        expect(result.hasApplied).toBe(false);
        expect(result.applicationStatus).toBeNull();
        expect(result.publicReason).toBeNull();
        expect(result.isSaved).toBe(false);
        expect(savedListingsMock.isListingSaved).not.toHaveBeenCalled();
      });

      it('returns empty application state when there is no blocking application', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        applicationsMock.findBlockingApplicationForListing.mockResolvedValue(
          undefined,
        );

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(
          applicationsMock.findBlockingApplicationForListing,
        ).toHaveBeenCalledWith(applicantUser.id, LISTING_ID);
        expect(result.hasApplied).toBe(false);
        expect(result.applicationStatus).toBeNull();
        expect(result.publicReason).toBeNull();
      });

      it.each([
        ApplicationStatus.ACTIVE,
        ApplicationStatus.WAITING,
        ApplicationStatus.ACCEPTED,
      ])('maps %s with null publicReason', async (status) => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        applicationsMock.findBlockingApplicationForListing.mockResolvedValue({
          status,
          publicReason: null,
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.hasApplied).toBe(true);
        expect(result.applicationStatus).toBe(status);
        expect(result.publicReason).toBeNull();
      });

      it('maps REJECTED with NOT_SELECTED publicReason', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        applicationsMock.findBlockingApplicationForListing.mockResolvedValue({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.NOT_SELECTED,
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.hasApplied).toBe(true);
        expect(result.applicationStatus).toBe(ApplicationStatus.REJECTED);
        expect(result.publicReason).toBe(
          ApplicationRejectionReason.NOT_SELECTED,
        );
      });

      it('maps REJECTED with other publicReason values', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        applicationsMock.findBlockingApplicationForListing.mockResolvedValue({
          status: ApplicationStatus.REJECTED,
          publicReason: ApplicationRejectionReason.LISTING_RENTED,
        });

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(result.publicReason).toBe(
          ApplicationRejectionReason.LISTING_RENTED,
        );
      });
    });

    describe('isSaved', () => {
      const applicantUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
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

      it('returns isSaved from the single lookup for active applicants', async () => {
        prismaMock.listing.findFirst.mockResolvedValue(discoveryDetail);
        savedListingsMock.isListingSaved.mockResolvedValue(true);

        const result = await service.findPublishedDetailForApplicant(
          LISTING_ID,
          applicantUser,
        );

        expect(savedListingsMock.isListingSaved).toHaveBeenCalledWith(
          applicantUser.id,
          LISTING_ID,
        );
        expect(result.isSaved).toBe(true);
      });
    });
  });
});
