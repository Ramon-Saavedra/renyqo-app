import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
import { ListingStatus, ObjectType } from '../generated/prisma/enums';
import { ApplicantListingSummaryDto } from '../listings/dto/applicant-listing-summary.dto';
import { ProfileMatch } from '../listings/dto/applicant-listing-profile-match.enum';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { SavedListingsService } from './saved-listings.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_LISTING_ID = '00000000-0000-4000-8000-000000000003';
const SAVED_ROW_ID = '00000000-0000-4000-8000-000000000010';
const SAVED_AT = new Date('2026-01-01T00:00:00.000Z');

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

const makeListing = (id: string) => ({
  id,
  title: `Listing ${id.slice(-1)}`,
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
  petsPolicy: null,
  smokingPolicy: null,
  publishedAt: new Date('2026-07-01'),
  images: [],
});

const makeSummary = (listingId: string): ApplicantListingSummaryDto =>
  new ApplicantListingSummaryDto(
    makeListing(listingId),
    ProfileMatch.UNKNOWN,
    new Date('2026-07-01'),
    {
      hasApplied: false,
      applicationStatus: null,
      publicReason: null,
    },
    true,
  );

type PrismaMock = {
  savedListing: {
    upsert: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    deleteMany: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
  };
  $transaction: jest.MockedFunction<
    (args: unknown) => Promise<[number, unknown[]]>
  >;
};

describe('SavedListingsService', () => {
  let service: SavedListingsService;
  let prismaMock: PrismaMock;
  let publishedListingsService: jest.Mocked<
    Pick<
      PublishedListingsService,
      'findPublishedListingOrThrow' | 'getPublicAccessWhere'
    >
  >;
  let applicantListingSummaryService: jest.Mocked<
    Pick<ApplicantListingSummaryService, 'buildSummaries'>
  >;

  beforeEach(async () => {
    prismaMock = {
      savedListing: {
        upsert: jest.fn<(args?: unknown) => Promise<unknown>>(),
        deleteMany: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        count: jest
          .fn<(args?: unknown) => Promise<number>>()
          .mockResolvedValue(0),
      },
      $transaction: jest.fn<(args: unknown) => Promise<[number, unknown[]]>>(),
    };

    publishedListingsService = {
      findPublishedListingOrThrow: jest.fn(),
      getPublicAccessWhere: jest
        .fn<
          () => import('../generated/prisma/client').Prisma.ListingWhereInput
        >()
        .mockReturnValue({
          status: ListingStatus.PUBLISHED,
          publishedAt: { not: null },
        }),
    };

    applicantListingSummaryService = {
      buildSummaries: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavedListingsService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: PublishedListingsService,
          useValue: publishedListingsService,
        },
        {
          provide: ApplicantListingSummaryService,
          useValue: applicantListingSummaryService,
        },
      ],
    }).compile();

    service = module.get(SavedListingsService);
  });

  describe('save', () => {
    it('upserts a saved listing for a published listing', async () => {
      publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
        id: LISTING_ID,
        status: ListingStatus.PUBLISHED,
        publishedAt: SAVED_AT,
      });
      prismaMock.savedListing.upsert.mockResolvedValue({ createdAt: SAVED_AT });

      const result = await service.save(APPLICANT_ID, LISTING_ID);

      expect(
        publishedListingsService.findPublishedListingOrThrow,
      ).toHaveBeenCalledWith(LISTING_ID);
      expect(result).toEqual({ saved: true, savedAt: SAVED_AT });
    });

    it('throws NotFoundException when the listing is not published', async () => {
      publishedListingsService.findPublishedListingOrThrow.mockRejectedValue(
        new NotFoundException('Listing not found'),
      );

      await expect(service.save(APPLICANT_ID, LISTING_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaMock.savedListing.upsert).not.toHaveBeenCalled();
    });
  });

  describe('unsave', () => {
    it('deletes the saved listing and returns saved false', async () => {
      prismaMock.savedListing.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.unsave(APPLICANT_ID, LISTING_ID);

      expect(result).toEqual({ saved: false, savedAt: null });
    });

    it('is idempotent when no saved row exists', async () => {
      prismaMock.savedListing.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.unsave(APPLICANT_ID, LISTING_ID);

      expect(result).toEqual({ saved: false, savedAt: null });
    });
  });

  describe('findSavedListingsPage', () => {
    beforeEach(() => {
      applicantListingSummaryService.buildSummaries.mockImplementation(
        (_applicant, listings) =>
          Promise.resolve(listings.map((listing) => makeSummary(listing.id))),
      );
    });

    it('filters by applicant and published listings only', async () => {
      prismaMock.$transaction.mockResolvedValue([0, []]);

      await service.findSavedListingsPage(applicantUser, {});

      expect(prismaMock.savedListing.count).toHaveBeenCalledWith({
        where: {
          AND: [
            { applicantId: APPLICANT_ID },
            {
              listing: {
                status: ListingStatus.PUBLISHED,
                publishedAt: { not: null },
              },
            },
          ],
        },
      });
    });

    it('orders by newest saved first and paginates', async () => {
      prismaMock.$transaction.mockResolvedValue([
        3,
        [
          {
            id: SAVED_ROW_ID,
            listingId: LISTING_ID,
            createdAt: SAVED_AT,
            listing: makeListing(LISTING_ID),
          },
          {
            id: '00000000-0000-4000-8000-000000000011',
            listingId: OTHER_LISTING_ID,
            createdAt: new Date('2025-12-31T00:00:00.000Z'),
            listing: makeListing(OTHER_LISTING_ID),
          },
        ],
      ]);

      const result = await service.findSavedListingsPage(applicantUser, {
        limit: 1,
      });

      expect(prismaMock.savedListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 2,
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).not.toBeNull();
      expect(result.total).toBe(3);
    });

    it('marks every returned item as saved through buildSummaries', async () => {
      prismaMock.$transaction.mockResolvedValue([
        1,
        [
          {
            id: SAVED_ROW_ID,
            listingId: LISTING_ID,
            createdAt: SAVED_AT,
            listing: makeListing(LISTING_ID),
          },
        ],
      ]);

      const result = await service.findSavedListingsPage(applicantUser, {});

      expect(
        applicantListingSummaryService.buildSummaries,
      ).toHaveBeenCalledWith(applicantUser, [makeListing(LISTING_ID)], {
        isSavedByListingId: new Set([LISTING_ID]),
      });
      expect(result.items[0].isSaved).toBe(true);
      expect(result.nextCursor).toBeNull();
    });

    it('rejects invalid cursors', async () => {
      await expect(
        service.findSavedListingsPage(applicantUser, {
          cursor: 'not-valid-base64',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sets private cache headers when a response object is provided', async () => {
      prismaMock.$transaction.mockResolvedValue([0, []]);
      const res = { setHeader: jest.fn() };

      await service.findSavedListingsPage(applicantUser, {}, res);

      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Cookie');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Cache-Control',
        'private, no-store, must-revalidate',
      );
    });
  });

  describe('findSavedListingIdsForListings', () => {
    it('returns an empty set when no listing ids are provided', async () => {
      const result = await service.findSavedListingIdsForListings(
        APPLICANT_ID,
        [],
      );

      expect(result).toEqual(new Set());
      expect(prismaMock.savedListing.findMany).not.toHaveBeenCalled();
    });

    it('returns saved listing ids in batch', async () => {
      prismaMock.savedListing.findMany.mockResolvedValue([
        { listingId: LISTING_ID },
      ]);

      const result = await service.findSavedListingIdsForListings(
        APPLICANT_ID,
        [LISTING_ID, '00000000-0000-4000-8000-000000000099'],
      );

      expect(result).toEqual(new Set([LISTING_ID]));
    });
  });

  describe('isListingSaved', () => {
    it('returns true when a saved row exists', async () => {
      prismaMock.savedListing.findUnique.mockResolvedValue({ id: 'saved-id' });

      await expect(
        service.isListingSaved(APPLICANT_ID, LISTING_ID),
      ).resolves.toBe(true);
    });

    it('returns false when no saved row exists', async () => {
      prismaMock.savedListing.findUnique.mockResolvedValue(null);

      await expect(
        service.isListingSaved(APPLICANT_ID, LISTING_ID),
      ).resolves.toBe(false);
    });
  });
});
