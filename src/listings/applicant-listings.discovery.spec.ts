import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UploadApiResponse } from 'cloudinary';

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
const LISTING_ID_2 = '00000000-0000-4000-8000-000000000003';
const CLOUDINARY_FOLDER = 'renyqo';

const makeApplicantProfile = (
  overrides: Partial<ApplicantProfile> = {},
): ApplicantProfile => ({
  id: '00000000-0000-4000-8000-000000000004',
  applicantId: '00000000-0000-4000-8000-000000000099',
  introduction: null,
  householdNetIncome: null,
  incomeProofAvailable: null,
  schufaAvailable: null,
  peopleCount: null,
  adultsCount: null,
  childrenCount: null,
  hasPets: null,
  isSmoker: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

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
  describe('findPublishedForApplicant', () => {
    const discoveryListing = makeDiscoveryListing();

    it('returns only PUBLISHED listings with publishedAt', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
            ]),
          },
        }),
      );
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      expect(result).toHaveProperty('total');
      expect(result.items).toHaveLength(0);
    });

    it('returns summaries with cover image', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(LISTING_ID);
      expect(result.items[0].title).toBe('Test Listing');
      expect(result.items[0].coverImage).toEqual({
        secureUrl: 'https://example.com/cover.jpg',
      });
    });

    it('handles null coverImage when no images exist', async () => {
      const noImage = makeDiscoveryListing({
        images: [],
      });
      prismaMock.listing.findMany.mockResolvedValue([noImage]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items[0].coverImage).toBeNull();
    });

    it('applies city filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({ city: 'Berlin' }, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { city: { equals: 'Berlin', mode: 'insensitive' } },
            ]),
          },
        }),
      );
    });

    it('applies rent range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { minRent: 500, maxRent: 2000 },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { coldRent: { gte: 500, lte: 2000 } },
            ]),
          },
        }),
      );
    });

    it('applies rooms range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        {
          minRooms: 1,
          maxRooms: 4,
        },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { rooms: { gte: 1, lte: 4 } },
            ]),
          },
        }),
      );
    });

    it('applies living area range filter', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        {
          minLivingArea: 20,
          maxLivingArea: 100,
        },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { livingArea: { gte: 20, lte: 100 } },
            ]),
          },
        }),
      );
    });

    it('returns null nextCursor when there are no more pages', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant(
        { limit: 50 },
        null,
      );

      expect(result.nextCursor).toBeNull();
    });

    it('returns nextCursor when there is a next page', async () => {
      const pageItems = Array.from({ length: 6 }, (_, i) =>
        makeDiscoveryListing({
          id: `00000000-0000-4000-8000-00000000000${i}`,
          publishedAt: new Date(2026, 6, 1 + i),
        }),
      );
      prismaMock.listing.findMany.mockResolvedValue(pageItems);

      const result = await service.findPublishedForApplicant(
        { limit: 5 },
        null,
      );

      expect(result.items).toHaveLength(5);
      expect(result.nextCursor).not.toBeNull();
      expect(typeof result.nextCursor).toBe('string');
    });

    it('rejects invalid cursor', async () => {
      try {
        await service.findPublishedForApplicant(
          { cursor: 'not-valid-base64' },
          null,
        );
        throw new Error('Expected invalid cursor to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
      }
    });

    it('returns empty page for no results', async () => {
      prismaMock.listing.findMany.mockResolvedValue([]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('excludes private fields from summaries', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      const summary = serialized(result.items[0]);
      expect(summary).not.toHaveProperty('providerId');
      expect(summary).not.toHaveProperty('minimumHouseholdNetIncome');
      expect(summary).not.toHaveProperty('schufaRequired');
      expect(summary).not.toHaveProperty('showExactAddress');
    });

    it('applicant with incomplete profile returns PROFILE_INCOMPLETE', async () => {
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
      prismaMock.applicantProfile.findUnique.mockResolvedValue(
        makeApplicantProfile(),
      );
      eligibilityMock.isProfileComplete.mockReturnValue(false);
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(
        ProfileMatch.PROFILE_INCOMPLETE,
      );
    });

    it('applicant with complete profile + eligible returns MATCH', async () => {
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
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.MATCH);
    });

    it('applicant with complete profile + not eligible returns NO_MATCH', async () => {
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
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, applicantUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.NO_MATCH);
    });

    it('null user returns UNKNOWN', async () => {
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, null);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
    });

    it('provider user returns UNKNOWN', async () => {
      const providerUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.PROVIDER,
        providerType: PublicProviderType.PRIVATE,
        companyName: null,
        emailVerified: false,
        status: UserStatus.ACTIVE,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, providerUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
      expect(result.items[0].hasApplied).toBe(false);
      expect(result.items[0].isSaved).toBe(false);
      expect(
        applicationsMock.findBlockingApplicationsForListings,
      ).not.toHaveBeenCalled();
      expect(
        savedListingsMock.findSavedListingIdsForListings,
      ).not.toHaveBeenCalled();
    });

    it('non-ACTIVE applicant returns UNKNOWN without profile lookup', async () => {
      const suspendedUser: SafeUser = {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'Test',
        email: 'test@test.com',
        role: Role.APPLICANT,
        providerType: null,
        companyName: null,
        emailVerified: false,
        status: UserStatus.SUSPENDED,
        acceptedTermsAt: new Date('2024-01-01'),
        acceptedPrivacyAt: new Date('2024-01-01'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };
      prismaMock.listing.count.mockResolvedValue(1);
      prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

      const result = await service.findPublishedForApplicant({}, suspendedUser);

      expect(result.items[0].profileMatch).toBe(ProfileMatch.UNKNOWN);
      expect(result.items[0].hasApplied).toBe(false);
      expect(result.items[0].isSaved).toBe(false);
      expect(prismaMock.applicantProfile.findUnique).not.toHaveBeenCalled();
      expect(
        applicationsMock.findBlockingApplicationsForListings,
      ).not.toHaveBeenCalled();
      expect(
        savedListingsMock.findSavedListingIdsForListings,
      ).not.toHaveBeenCalled();
    });

    it('sets cache-control headers on the response', async () => {
      const res = { setHeader: jest.fn() };
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({}, null, res);

      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store, must-revalidate',
      );
    });

    it('throws BadRequestException when cursor sort does not match', async () => {
      const payload = {
        sort: 'newest',
        publishedAt: '2026-07-01T00:00:00.000Z',
        id: '00000000-0000-4000-8000-000000000001',
      };
      const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url');

      await expect(
        Promise.resolve().then(() =>
          service.findPublishedForApplicant(
            { cursor, sort: 'price-asc' },
            null,
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('applies free-text query search across title, city, zip and district', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant({ query: 'Berlin' }, null);

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              {
                OR: [
                  {
                    title: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    city: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    zip: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                  {
                    district: {
                      contains: '%Berlin%',
                      mode: 'insensitive',
                    },
                  },
                ],
              },
            ]),
          },
        }),
      );
    });

    it('applies availableBy filter with Berlin midnight', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { availableBy: '2026-08-01' },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { availableFrom: { not: null } },
              {
                availableFrom: {
                  lt: new Date('2026-08-01T22:00:00.000Z'),
                },
              },
            ]),
          },
        }),
      );
    });

    it('applies petsPolicy filter', async () => {
      prismaMock.listing.count.mockResolvedValue(0);
      prismaMock.listing.findMany.mockResolvedValue([]);

      await service.findPublishedForApplicant(
        { petsPolicy: PetsPolicy.ALLOWED },
        null,
      );

      expect(prismaMock.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { status: ListingStatus.PUBLISHED },
              { publishedAt: { not: null } },
              { petsPolicy: PetsPolicy.ALLOWED },
            ]),
          },
        }),
      );
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

      it('returns empty application state when the applicant has no application', async () => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);
        applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
          new Map(),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(
          applicationsMock.findBlockingApplicationsForListings,
        ).toHaveBeenCalledWith(applicantUser.id, [LISTING_ID]);
        expect(result.items[0].hasApplied).toBe(false);
        expect(result.items[0].applicationStatus).toBeNull();
        expect(result.items[0].publicReason).toBeNull();
      });

      it.each([
        ApplicationStatus.ACTIVE,
        ApplicationStatus.WAITING,
        ApplicationStatus.ACCEPTED,
      ])('maps %s with null publicReason', async (status) => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);
        applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
          new Map([[LISTING_ID, { status, publicReason: null }]]),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(result.items[0].hasApplied).toBe(true);
        expect(result.items[0].applicationStatus).toBe(status);
        expect(result.items[0].publicReason).toBeNull();
      });

      it('maps REJECTED with NOT_SELECTED publicReason', async () => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);
        applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
          new Map([
            [
              LISTING_ID,
              {
                status: ApplicationStatus.REJECTED,
                publicReason: ApplicationRejectionReason.NOT_SELECTED,
              },
            ],
          ]),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(result.items[0].hasApplied).toBe(true);
        expect(result.items[0].applicationStatus).toBe(
          ApplicationStatus.REJECTED,
        );
        expect(result.items[0].publicReason).toBe(
          ApplicationRejectionReason.NOT_SELECTED,
        );
      });

      it('maps REJECTED with other publicReason values', async () => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);
        applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
          new Map([
            [
              LISTING_ID,
              {
                status: ApplicationStatus.REJECTED,
                publicReason: ApplicationRejectionReason.LISTING_RENTED,
              },
            ],
          ]),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(result.items[0].publicReason).toBe(
          ApplicationRejectionReason.LISTING_RENTED,
        );
      });

      it('does not query applications when the page is empty', async () => {
        prismaMock.listing.findMany.mockResolvedValue([]);

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(
          applicationsMock.findBlockingApplicationsForListings,
        ).not.toHaveBeenCalled();
        expect(result.items).toEqual([]);
      });

      it('sets application state per listing from the batch lookup result', async () => {
        const secondListing = makeDiscoveryListing({ id: LISTING_ID_2 });
        prismaMock.listing.findMany.mockResolvedValue([
          discoveryListing,
          secondListing,
        ]);
        applicationsMock.findBlockingApplicationsForListings.mockResolvedValue(
          new Map([
            [
              LISTING_ID_2,
              {
                status: ApplicationStatus.ACTIVE,
                publicReason: null,
              },
            ],
          ]),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(
          applicationsMock.findBlockingApplicationsForListings,
        ).toHaveBeenCalledWith(applicantUser.id, [LISTING_ID, LISTING_ID_2]);
        expect(result.items[0].hasApplied).toBe(false);
        expect(result.items[0].applicationStatus).toBeNull();
        expect(result.items[1].hasApplied).toBe(true);
        expect(result.items[1].applicationStatus).toBe(
          ApplicationStatus.ACTIVE,
        );
      });

      it('returns empty application state for anonymous callers without querying applications', async () => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

        const result = await service.findPublishedForApplicant({}, null);

        expect(
          applicationsMock.findBlockingApplicationsForListings,
        ).not.toHaveBeenCalled();
        expect(result.items[0].hasApplied).toBe(false);
        expect(result.items[0].applicationStatus).toBeNull();
        expect(result.items[0].publicReason).toBeNull();
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

      it('returns isSaved false for anonymous callers without querying saved listings', async () => {
        prismaMock.listing.findMany.mockResolvedValue([discoveryListing]);

        const result = await service.findPublishedForApplicant({}, null);

        expect(
          savedListingsMock.findSavedListingIdsForListings,
        ).not.toHaveBeenCalled();
        expect(result.items[0].isSaved).toBe(false);
      });

      it('sets isSaved per listing from the batch lookup result', async () => {
        const secondListing = makeDiscoveryListing({ id: LISTING_ID_2 });
        prismaMock.listing.findMany.mockResolvedValue([
          discoveryListing,
          secondListing,
        ]);
        savedListingsMock.findSavedListingIdsForListings.mockResolvedValue(
          new Set([LISTING_ID_2]),
        );

        const result = await service.findPublishedForApplicant(
          {},
          applicantUser,
        );

        expect(
          savedListingsMock.findSavedListingIdsForListings,
        ).toHaveBeenCalledWith(applicantUser.id, [LISTING_ID, LISTING_ID_2]);
        expect(result.items[0].isSaved).toBe(false);
        expect(result.items[1].isSaved).toBe(true);
      });

      it('does not query saved listings when the page is empty', async () => {
        prismaMock.listing.findMany.mockResolvedValue([]);

        await service.findPublishedForApplicant({}, applicantUser);

        expect(
          savedListingsMock.findSavedListingIdsForListings,
        ).not.toHaveBeenCalled();
      });
    });
  });
});
