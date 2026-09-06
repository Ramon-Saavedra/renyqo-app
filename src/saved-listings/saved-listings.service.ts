import { BadRequestException, Injectable } from '@nestjs/common';

import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
import { APPLICANT_LISTING_SUMMARY_LISTING_SELECT } from '../applicant-listing-summaries/applicant-listing-summary-listing.select';
import type { Prisma } from '../generated/prisma/client';
import { ApplicantListingsPageDto } from '../listings/dto/applicant-listings-page.dto';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SafeUser } from '../users/types/safe-user.type';
import type { SavedListingsQueryDto } from './dto/saved-listings-query.dto';

export type SaveListingResult = {
  readonly saved: boolean;
  readonly savedAt: Date | null;
};

const SAVED_LISTINGS_PAGE_SIZE_DEFAULT = 20;
const SAVED_LISTINGS_PAGE_SIZE_MAX = 50;
const CURSOR_MAX_LENGTH = 256;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SavedListingCursorPayload = {
  savedAt: string;
  id: string;
};

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isSavedListingCursorPayload(
  value: unknown,
): value is SavedListingCursorPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    isDateString(record.savedAt) &&
    typeof record.id === 'string' &&
    UUID_REGEX.test(record.id)
  );
}

function encodeSavedListingCursor(row: {
  createdAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      savedAt: row.createdAt.toISOString(),
      id: row.id,
    }),
  ).toString('base64url');
}

function decodeSavedListingCursor(
  cursor: string,
): SavedListingCursorPayload | null {
  if (cursor.length > CURSOR_MAX_LENGTH) {
    return null;
  }

  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!isSavedListingCursorPayload(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

@Injectable()
export class SavedListingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publishedListingsService: PublishedListingsService,
    private readonly applicantListingSummaryService: ApplicantListingSummaryService,
  ) {}

  async save(
    applicantId: string,
    listingId: string,
  ): Promise<SaveListingResult> {
    await this.publishedListingsService.findPublishedListingOrThrow(listingId);

    const savedListing = await this.prisma.savedListing.upsert({
      where: {
        applicantId_listingId: {
          applicantId,
          listingId,
        },
      },
      create: {
        applicantId,
        listingId,
      },
      update: {},
      select: { createdAt: true },
    });

    return {
      saved: true,
      savedAt: savedListing.createdAt,
    };
  }

  async unsave(
    applicantId: string,
    listingId: string,
  ): Promise<SaveListingResult> {
    await this.prisma.savedListing.deleteMany({
      where: {
        applicantId,
        listingId,
      },
    });

    return {
      saved: false,
      savedAt: null,
    };
  }

  async findSavedListingsPage(
    applicant: SafeUser,
    query: SavedListingsQueryDto,
    res?: { setHeader(name: string, value: string): void },
  ): Promise<ApplicantListingsPageDto> {
    const take = Math.min(
      query.limit ?? SAVED_LISTINGS_PAGE_SIZE_DEFAULT,
      SAVED_LISTINGS_PAGE_SIZE_MAX,
    );

    const baseWhere = this.buildSavedListingsWhere(applicant.id, query.cursor);

    const [total, savedListings] = await this.prisma.$transaction([
      this.prisma.savedListing.count({ where: baseWhere }),
      this.prisma.savedListing.findMany({
        where: baseWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        select: {
          id: true,
          listingId: true,
          createdAt: true,
          listing: {
            select: APPLICANT_LISTING_SUMMARY_LISTING_SELECT,
          },
        },
      }),
    ]);

    const hasMore = savedListings.length > take;
    const pageRows = hasMore ? savedListings.slice(0, take) : savedListings;

    const listings = pageRows.map((row) => row.listing);
    const isSavedByListingId = new Set(listings.map((listing) => listing.id));

    const summaries = await this.applicantListingSummaryService.buildSummaries(
      applicant,
      listings,
      { isSavedByListingId },
    );

    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeSavedListingCursor(pageRows[pageRows.length - 1])
        : null;

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    return new ApplicantListingsPageDto(summaries, nextCursor, total);
  }

  async findSavedListingIdsForListings(
    applicantId: string,
    listingIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (listingIds.length === 0) {
      return new Set();
    }

    const savedListings = await this.prisma.savedListing.findMany({
      where: {
        applicantId,
        listingId: { in: [...listingIds] },
      },
      select: { listingId: true },
    });

    return new Set(savedListings.map((savedListing) => savedListing.listingId));
  }

  async isListingSaved(
    applicantId: string,
    listingId: string,
  ): Promise<boolean> {
    const savedListing = await this.prisma.savedListing.findUnique({
      where: {
        applicantId_listingId: {
          applicantId,
          listingId,
        },
      },
      select: { id: true },
    });

    return savedListing !== null;
  }

  private buildSavedListingsWhere(
    applicantId: string,
    cursor: string | undefined,
  ): Prisma.SavedListingWhereInput {
    const conditions: Prisma.SavedListingWhereInput[] = [
      { applicantId },
      { listing: this.publishedListingsService.getPublicAccessWhere() },
    ];

    if (cursor !== undefined) {
      const decoded = decodeSavedListingCursor(cursor);

      if (!decoded) {
        throw new BadRequestException('Invalid cursor');
      }

      const savedAt = new Date(decoded.savedAt);

      conditions.push({
        OR: [
          { createdAt: { lt: savedAt } },
          {
            createdAt: savedAt,
            id: { lt: decoded.id },
          },
        ],
      });
    }

    return { AND: conditions };
  }
}
