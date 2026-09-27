import { BadRequestException, Injectable } from '@nestjs/common';

import type { ApplicantProfile, Prisma } from '../generated/prisma/client';
import { APPLICANT_LISTING_SUMMARY_LISTING_SELECT } from '../applicant-listing-summaries/applicant-listing-summary-listing.select';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import type {
  ApplicantListingsQueryDto,
  DiscoverySort,
} from './dto/applicant-listings-query.dto';

const DISCOVERY_PAGE_SIZE_DEFAULT = 20;
const DISCOVERY_PAGE_SIZE_MAX = 50;
const CURSOR_MAX_LENGTH = 256;
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const DISCOVERY_SORT_FIELDS: Record<DiscoverySort, string> = {
  newest: 'publishedAt',
  'price-asc': 'coldRent',
  'price-desc': 'coldRent',
  'area-desc': 'livingArea',
};

interface NewestCursorPayload {
  sort: 'newest';
  publishedAt: string;
  id: string;
}

interface SortedCursorPayload {
  sort: 'price-asc' | 'price-desc' | 'area-desc';
  value: number;
  id: string;
}

type CursorPayload =
  | NewestCursorPayload
  | SortedCursorPayload
  | { publishedAt: string; id: string };

function toBerlinMidnight(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);

  return new Date(Date.UTC(year, month - 1, day, 22, 0, 0, 0));
}

function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const date = new Date(value);

  return !Number.isNaN(date.getTime()) && value === date.toISOString();
}

function isLegacyCursorPayload(value: unknown): value is {
  publishedAt: string;
  id: string;
} {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'publishedAt') {
    return false;
  }

  return (
    isDateString(record.publishedAt) &&
    typeof record.id === 'string' &&
    UUID_REGEX.test(record.id)
  );
}

function isNewestCursorPayload(value: unknown): value is NewestCursorPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (
    keys.length !== 3 ||
    keys[0] !== 'id' ||
    keys[1] !== 'publishedAt' ||
    keys[2] !== 'sort'
  ) {
    return false;
  }

  return (
    record.sort === 'newest' &&
    isDateString(record.publishedAt) &&
    typeof record.id === 'string' &&
    UUID_REGEX.test(record.id)
  );
}

function isSortedCursorPayload(value: unknown): value is SortedCursorPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (
    keys.length !== 3 ||
    keys[0] !== 'id' ||
    keys[1] !== 'sort' ||
    keys[2] !== 'value'
  ) {
    return false;
  }

  return (
    (record.sort === 'price-asc' ||
      record.sort === 'price-desc' ||
      record.sort === 'area-desc') &&
    typeof record.value === 'number' &&
    Number.isFinite(record.value) &&
    typeof record.id === 'string' &&
    UUID_REGEX.test(record.id)
  );
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return (
    isLegacyCursorPayload(value) ||
    isNewestCursorPayload(value) ||
    isSortedCursorPayload(value)
  );
}

@Injectable()
export class ApplicantListingDiscoveryQuery {
  constructor(
    private readonly eligibilityService: EligibilityService,
    private readonly publishedListingsService: PublishedListingsService,
  ) {}

  getPageSize(query: ApplicantListingsQueryDto): number {
    return Math.min(
      query.limit ?? DISCOVERY_PAGE_SIZE_DEFAULT,
      DISCOVERY_PAGE_SIZE_MAX,
    );
  }

  getSelect(): Prisma.ListingSelect {
    return APPLICANT_LISTING_SUMMARY_LISTING_SELECT;
  }

  getSortOrder(sort: DiscoverySort): Prisma.ListingOrderByWithRelationInput[] {
    const isAsc = sort === 'price-asc';
    const field = DISCOVERY_SORT_FIELDS[sort];
    const order: Prisma.SortOrder = isAsc ? 'asc' : 'desc';

    const primary: Prisma.ListingOrderByWithRelationInput = {};
    (primary as Record<string, Prisma.SortOrder>)[field] = order;

    const secondary: Prisma.ListingOrderByWithRelationInput = { id: order };

    return [primary, secondary];
  }

  encodeCursor(
    sort: DiscoverySort,
    listing: {
      publishedAt: Date | null;
      coldRent: number | null;
      livingArea: number | null;
      id: string;
    },
  ): string {
    const payload: Record<string, unknown> = { sort };

    if (sort === 'newest') {
      payload.publishedAt = listing.publishedAt!.toISOString();
    } else if (sort === 'price-asc' || sort === 'price-desc') {
      payload.value = listing.coldRent;
    } else {
      payload.value = listing.livingArea;
    }

    payload.id = listing.id;

    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  decodeCursor(cursor: string): CursorPayload | null {
    if (cursor.length > CURSOR_MAX_LENGTH) {
      return null;
    }

    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed: unknown = JSON.parse(raw);

      return isCursorPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  buildWhere(
    query: ApplicantListingsQueryDto,
    sort: DiscoverySort,
    profile: ApplicantProfile | null,
  ): Prisma.ListingWhereInput {
    const conditions: Prisma.ListingWhereInput[] = [
      ...this.publishedListingsService.getPublicAccessWhereFragments(),
    ];

    if (query.city) {
      conditions.push({
        city: { equals: query.city, mode: 'insensitive' },
      });
    }

    if (query.minRent !== undefined || query.maxRent !== undefined) {
      const coldRent: Prisma.FloatNullableFilter<'Listing'> = {};

      if (query.minRent !== undefined) coldRent.gte = query.minRent;
      if (query.maxRent !== undefined) coldRent.lte = query.maxRent;

      conditions.push({ coldRent });
    }

    if (query.minRooms !== undefined || query.maxRooms !== undefined) {
      const rooms: Prisma.FloatNullableFilter<'Listing'> = {};

      if (query.minRooms !== undefined) rooms.gte = query.minRooms;
      if (query.maxRooms !== undefined) rooms.lte = query.maxRooms;

      conditions.push({ rooms });
    }

    if (
      query.minLivingArea !== undefined ||
      query.maxLivingArea !== undefined
    ) {
      const livingArea: Prisma.FloatNullableFilter<'Listing'> = {};

      if (query.minLivingArea !== undefined) {
        livingArea.gte = query.minLivingArea;
      }
      if (query.maxLivingArea !== undefined) {
        livingArea.lte = query.maxLivingArea;
      }

      conditions.push({ livingArea });
    }

    if (query.availableBy) {
      const berlinMidnight = toBerlinMidnight(query.availableBy);

      conditions.push({ availableFrom: { not: null } });
      conditions.push({ availableFrom: { lt: berlinMidnight } });
    }

    if (query.query) {
      const pattern = `%${query.query}%`;

      conditions.push({
        OR: [
          { title: { contains: pattern, mode: 'insensitive' } },
          { city: { contains: pattern, mode: 'insensitive' } },
          { zip: { contains: pattern, mode: 'insensitive' } },
          { district: { contains: pattern, mode: 'insensitive' } },
        ],
      });
    }

    if (query.petsPolicy) {
      conditions.push({ petsPolicy: query.petsPolicy });
    }

    if (query.onlyMatching && profile) {
      conditions.push(this.eligibilityService.buildHardMatchWhere(profile));
    }

    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor);

      if (!cursor) throw new BadRequestException('Invalid cursor');

      const cursorSort: DiscoverySort =
        'sort' in cursor ? cursor.sort : 'newest';

      if (cursorSort !== sort) {
        throw new BadRequestException(
          'Cursor sort does not match requested sort',
        );
      }

      if (cursorSort === 'newest') {
        const cursorWithPublishedAt =
          'publishedAt' in cursor && typeof cursor.publishedAt === 'string'
            ? cursor
            : null;

        if (!cursorWithPublishedAt) {
          throw new BadRequestException('Invalid cursor');
        }

        const newestCursor = cursorWithPublishedAt;
        const publishedAt = new Date(newestCursor.publishedAt);

        conditions.push({
          OR: [
            { publishedAt: { lt: publishedAt } },
            { publishedAt, id: { lt: newestCursor.id } },
          ],
        });
      } else {
        const cursorWithValue =
          'value' in cursor && typeof cursor.value === 'number' ? cursor : null;

        if (!cursorWithValue) {
          throw new BadRequestException('Invalid cursor');
        }

        const sortedCursor = cursorWithValue;
        const field = DISCOVERY_SORT_FIELDS[cursorSort];
        const isAsc = cursorSort === 'price-asc';

        conditions.push({
          OR: [
            { [field]: { [isAsc ? 'gt' : 'lt']: sortedCursor.value } },
            {
              [field]: sortedCursor.value,
              id: { [isAsc ? 'gt' : 'lt']: sortedCursor.id },
            },
          ],
        });
      }
    }

    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  }
}
