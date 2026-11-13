import { publicListingSource } from '../published-listings/public-listing-source';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { ApplicantListingAccess } from '../listings/applicant-listing-access';
import { BadRequestException, Injectable } from '@nestjs/common';

import { ApplicantListingSummaryService } from '../applicant-listing-summaries/applicant-listing-summary.service';
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
    private readonly access: ApplicantListingAccess,
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
    authority?: HumanAuthority,
  ): Promise<ApplicantListingsPageDto> {
    if (!authority || authority.userId !== applicant.id)
      throw new BadRequestException('Applicant session authority required');
    await this.access.assertPrincipal(authority);
    const take = Math.min(
      query.limit ?? SAVED_LISTINGS_PAGE_SIZE_DEFAULT,
      SAVED_LISTINGS_PAGE_SIZE_MAX,
    );

    const cursor = query.cursor ? decodeSavedListingCursor(query.cursor) : null;
    if (query.cursor && !cursor)
      throw new BadRequestException('Invalid cursor');
    const cursorDate = cursor ? new Date(cursor.savedAt) : null;
    const cursorId = cursor?.id ?? null;
    const [total, savedListings] = await this.prisma.$transaction(
      async (tx) => {
        const [count] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS count FROM saved_listings s JOIN public_listing_projections p ON p.id=s.listing_id
        WHERE s.applicant_id=${applicant.id}::uuid`;
        const refs = await tx.$queryRaw<
          { id: string; listing_id: string; created_at: Date }[]
        >`
        SELECT s.id,s.listing_id,s.created_at FROM saved_listings s JOIN public_listing_projections p ON p.id=s.listing_id
        WHERE s.applicant_id=${applicant.id}::uuid AND (${cursorDate}::timestamp IS NULL OR s.created_at<${cursorDate}::timestamp
          OR (s.created_at=${cursorDate}::timestamp AND s.id<${cursorId}::uuid))
        ORDER BY s.created_at DESC,s.id DESC LIMIT ${take + 1}`;
        const projections = await tx.publicListingProjection.findMany({
          where: { id: { in: refs.map((r) => r.listing_id) } },
        });
        const byId = new Map(projections.map((p) => [p.id, p]));
        return [
          Number(count.count),
          refs.map((r) => ({
            id: r.id,
            listingId: r.listing_id,
            createdAt: r.created_at,
            listing: publicListingSource(byId.get(r.listing_id)!),
          })),
        ] as const;
      },
      { isolationLevel: 'RepeatableRead' },
    );

    const hasMore = savedListings.length > take;
    const pageRows = hasMore ? savedListings.slice(0, take) : savedListings;

    const listings = pageRows.map((row) => row.listing);
    const isSavedByListingId = new Set(listings.map((listing) => listing.id));

    const summaries = await this.applicantListingSummaryService.buildSummaries(
      applicant,
      listings,
      { isSavedByListingId, authority },
    );

    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeSavedListingCursor(pageRows[pageRows.length - 1])
        : null;

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    await this.access.assertPrincipal(authority);
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
}
