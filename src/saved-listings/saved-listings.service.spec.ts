import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
import { ListingStatus, ObjectType } from '../generated/prisma/enums';
import { ApplicantListingSummaryDto } from '../listings/dto/applicant-listing-summary.dto';
import { ProfileMatch } from '../listings/dto/applicant-listing-profile-match.enum';
import { unitSession } from '../../test/unit-workspace-authority';
import { ApplicantListingAccess } from '../listings/applicant-listing-access';
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
    <R>(args: (tx: unknown) => Promise<R>) => Promise<R>
  >;
};

describe('SavedListingsService', () => {
  let service: SavedListingsService;
  let prismaMock: PrismaMock;
  let publishedListingsService: jest.Mocked<
    Pick<PublishedListingsService, 'findPublishedListingOrThrow'>
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
      $transaction: jest.fn(async <R>(work: (tx: unknown) => Promise<R>) =>
        work({}),
      ) as PrismaMock['$transaction'],
    };

    publishedListingsService = {
      findPublishedListingOrThrow: jest.fn(),
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
        {
          provide: ApplicantListingAccess,
          useValue: { assertPrincipal: () => Promise.resolve() },
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

    it('filters by applicant and the public listing projection only', async () => {
      const queries: unknown[][] = [];
      prismaMock.$transaction.mockImplementation(async (work) => {
        const tx = {
          $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown[]>>(
            (...args: unknown[]) => {
              queries.push(args);
              return Promise.resolve(
                queries.length === 1 ? [{ count: 0n }] : [],
              );
            },
          ),
          publicListingProjection: {
            findMany: jest.fn(() => Promise.resolve([])),
          },
        };
        return work(tx);
      });

      await service.findSavedListingsPage(
        applicantUser,
        {},
        undefined,
        unitSession(APPLICANT_ID),
      );

      expect(queries[0]?.join(' ')).toContain('public_listing_projections');
      expect(queries[0]).toContain(APPLICANT_ID);
      expect(prismaMock.savedListing.count).not.toHaveBeenCalled();
    });

    it('orders by newest saved first and paginates', async () => {
      const rows = [
        { id: SAVED_ROW_ID, listing_id: LISTING_ID, created_at: SAVED_AT },
        {
          id: '00000000-0000-4000-8000-000000000011',
          listing_id: OTHER_LISTING_ID,
          created_at: new Date('2025-12-31T00:00:00.000Z'),
        },
      ];
      prismaMock.$transaction.mockImplementation(async (work) => {
        const tx = {
          $queryRaw: jest
            .fn<() => Promise<unknown[]>>()
            .mockResolvedValueOnce([{ count: 3n }])
            .mockResolvedValueOnce(rows),
          publicListingProjection: {
            findMany: jest.fn(() =>
              Promise.resolve(
                rows.map((row) => ({
                  id: row.listing_id,
                  title: 'Saved',
                  city: 'Berlin',
                  zip: '10115',
                  district: null,
                  country: 'DE',
                  objectType: null,
                  livingArea: null,
                  rooms: null,
                  bedrooms: null,
                  coldRent: null,
                  additionalCosts: null,
                  deposit: null,
                  depositMonths: 2,
                  availableFrom: null,
                  shortDescription: null,
                  publicStreet: null,
                  photos: [],
                  publishedAt: SAVED_AT,
                  minimumHouseholdNetIncome: null,
                  schufaRequired: false,
                  incomeProofRequired: false,
                  suitableForPeopleCount: null,
                  petsPolicy: null,
                  smokingPolicy: null,
                })),
              ),
            ),
          },
        };
        return work(tx);
      });

      const result = await service.findSavedListingsPage(
        applicantUser,
        { limit: 1 },
        undefined,
        unitSession(APPLICANT_ID),
      );

      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).not.toBeNull();
      expect(result.total).toBe(3);
    });

    it('marks every returned item as saved through buildSummaries', async () => {
      prismaMock.$transaction.mockImplementation(async (work) => {
        const tx = {
          $queryRaw: jest
            .fn<() => Promise<unknown[]>>()
            .mockResolvedValueOnce([{ count: 1n }])
            .mockResolvedValueOnce([
              {
                id: SAVED_ROW_ID,
                listing_id: LISTING_ID,
                created_at: SAVED_AT,
              },
            ]),
          publicListingProjection: {
            findMany: jest.fn(() =>
              Promise.resolve([
                {
                  id: LISTING_ID,
                  title: 'Saved',
                  city: 'Berlin',
                  zip: '10115',
                  district: null,
                  country: 'DE',
                  objectType: null,
                  livingArea: null,
                  rooms: null,
                  bedrooms: null,
                  coldRent: null,
                  additionalCosts: null,
                  deposit: null,
                  depositMonths: 2,
                  availableFrom: null,
                  shortDescription: null,
                  publicStreet: null,
                  photos: [],
                  publishedAt: SAVED_AT,
                  minimumHouseholdNetIncome: null,
                  schufaRequired: false,
                  incomeProofRequired: false,
                  suitableForPeopleCount: null,
                  petsPolicy: null,
                  smokingPolicy: null,
                },
              ]),
            ),
          },
        };
        return work(tx);
      });

      const result = await service.findSavedListingsPage(
        applicantUser,
        {},
        undefined,
        unitSession(APPLICANT_ID),
      );

      expect(
        applicantListingSummaryService.buildSummaries,
      ).toHaveBeenCalledWith(
        applicantUser,
        [expect.objectContaining({ id: LISTING_ID })],
        {
          isSavedByListingId: new Set([LISTING_ID]),
          authority: unitSession(APPLICANT_ID),
        },
      );
      expect(result.items[0].isSaved).toBe(true);
      expect(result.nextCursor).toBeNull();
    });

    it('rejects invalid cursors', async () => {
      await expect(
        service.findSavedListingsPage(
          applicantUser,
          { cursor: 'not-valid-base64' },
          undefined,
          unitSession(APPLICANT_ID),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('sets private cache headers when a response object is provided', async () => {
      prismaMock.$transaction.mockImplementation(async (work) => {
        const tx = {
          $queryRaw: jest
            .fn<() => Promise<unknown[]>>()
            .mockResolvedValueOnce([{ count: 0n }])
            .mockResolvedValueOnce([]),
          publicListingProjection: {
            findMany: jest.fn(() => Promise.resolve([])),
          },
        };
        return work(tx);
      });
      const res = { setHeader: jest.fn() };

      await service.findSavedListingsPage(
        applicantUser,
        {},
        res,
        unitSession(APPLICANT_ID),
      );

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
