import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { UploadApiResponse } from 'cloudinary';
import type { EnvironmentVariables } from '../config/env.validation';
import type { ApplicantProfile, Listing } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
  Role,
  UserStatus,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { EligibilityService } from '../eligibility/eligibility.service';
import type { SafeUser } from '../users/types/safe-user.type';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import type { ListingWithImages } from './dto/listing-response.dto';
import {
  ProviderListingOverviewResponseDto,
  type ListingWithActiveApplicationsCount,
} from './dto/provider-listing-overview-response.dto';
import type { UpdateListingDto } from './dto/update-listing.dto';
import { ApplicantListingDetailDto } from './dto/applicant-listing-detail.dto';
import {
  ApplicantListingSummaryDto,
  type ApplicantListingSummarySource,
} from './dto/applicant-listing-summary.dto';
import { ApplicantListingsPageDto } from './dto/applicant-listings-page.dto';
import type {
  ApplicantListingsQueryDto,
  DiscoverySort,
} from './dto/applicant-listings-query.dto';
import { ProfileMatch } from './dto/applicant-listing-profile-match.enum';
import type { RentListingDto } from './dto/rent-listing.dto';

const PUBLISH_REQUIRED_FIELDS = [
  'title',
  'street',
  'zip',
  'city',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'availableFrom',
] as const;

type PublishRequiredField = (typeof PUBLISH_REQUIRED_FIELDS)[number];

const DEFAULT_DEPOSIT_MONTHS = 2;
const MIN_DEPOSIT_MONTHS = 1;
const MAX_DEPOSIT_MONTHS = 3;
const DEPOSIT_AMOUNT_TOLERANCE = 0.01;

const ELIGIBILITY_CRITERIA_FIELDS = [
  'minimumHouseholdNetIncome',
  'schufaRequired',
  'incomeProofRequired',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
] as const;

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

function toBerlinMidnight(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);

  return new Date(Date.UTC(year, month - 1, day, 22, 0, 0, 0));
}

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

  if (!isDateString(record.publishedAt)) {
    return false;
  }

  if (typeof record.id !== 'string' || !UUID_REGEX.test(record.id)) {
    return false;
  }

  return true;
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

  if (record.sort !== 'newest') {
    return false;
  }

  if (!isDateString(record.publishedAt)) {
    return false;
  }

  if (typeof record.id !== 'string' || !UUID_REGEX.test(record.id)) {
    return false;
  }

  return true;
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

  if (
    record.sort !== 'price-asc' &&
    record.sort !== 'price-desc' &&
    record.sort !== 'area-desc'
  ) {
    return false;
  }

  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
    return false;
  }

  if (typeof record.id !== 'string' || !UUID_REGEX.test(record.id)) {
    return false;
  }

  return true;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return (
    isLegacyCursorPayload(value) ||
    isNewestCursorPayload(value) ||
    isSortedCursorPayload(value)
  );
}

function encodeCursor(
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

function decodeCursor(cursor: string): CursorPayload | null {
  if (cursor.length > CURSOR_MAX_LENGTH) {
    return null;
  }

  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!isCursorPayload(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function getSortOrder(
  sort: DiscoverySort,
): Prisma.ListingOrderByWithRelationInput[] {
  const isAsc = sort === 'price-asc';
  const field = DISCOVERY_SORT_FIELDS[sort];
  const order: Prisma.SortOrder = isAsc ? 'asc' : 'desc';

  const primary: Prisma.ListingOrderByWithRelationInput = {};
  (primary as Record<string, Prisma.SortOrder>)[field] = order;

  const secondary: Prisma.ListingOrderByWithRelationInput = { id: order };

  return [primary, secondary];
}

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly eligibilityService: EligibilityService,
  ) {}

  async create(
    providerId: string,
    dto: CreateListingDto,
    file?: Express.Multer.File,
  ): Promise<Listing> {
    if (!this.hasMeaningfulDraftData(dto) && !file) {
      throw new BadRequestException(
        'Draft must include at least one listing field',
      );
    }

    if (file) {
      return this.createWithImage(providerId, dto, file);
    }

    return this.prisma.listing.create({
      data: this.buildCreateData(providerId, dto),
    });
  }

  async findAllByProvider(
    providerId: string,
  ): Promise<ListingWithActiveApplicationsCount[]> {
    return this.prisma.listing.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            applications: {
              where: { status: ApplicationStatus.ACTIVE },
            },
          },
        },
      },
    });
  }

  async findOneByProvider(id: string, providerId: string): Promise<Listing> {
    const listing = await this.prisma.listing.findFirst({
      where: { id, providerId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  async findOneDetailByProvider(
    id: string,
    providerId: string,
  ): Promise<ListingWithImages> {
    const listing = await this.prisma.listing.findFirst({
      where: { id, providerId },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return listing;
  }

  async update(
    id: string,
    providerId: string,
    dto: UpdateListingDto,
  ): Promise<Listing> {
    const listing = await this.findOneByProvider(id, providerId);
    return this.prisma.listing.update({
      where: { id },
      data: this.buildUpdateData(dto, listing),
    });
  }

  async publish(id: string, providerId: string): Promise<Listing> {
    const listing = await this.findOneByProvider(id, providerId);

    const missingFields = PUBLISH_REQUIRED_FIELDS.filter(
      (field: PublishRequiredField) => listing[field] == null,
    );

    if (missingFields.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Listing is missing required fields for publishing',
        missingFields,
      });
    }

    return this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.PUBLISHED, publishedAt: new Date() },
    });
  }

  async moveToDraft(id: string, providerId: string): Promise<Listing> {
    await this.findOneByProvider(id, providerId);
    return this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DRAFT },
    });
  }

  async archive(id: string, providerId: string): Promise<Listing> {
    await this.findOneByProvider(id, providerId);
    return this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.ARCHIVED },
    });
  }

  async rentListing(
    id: string,
    providerId: string,
    dto: RentListingDto,
  ): Promise<Listing> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${id} FOR UPDATE`;

      const listing = await tx.listing.findFirst({
        where: { id, providerId },
      });

      if (!listing) {
        throw new NotFoundException('Listing not found');
      }

      if (
        listing.status !== ListingStatus.PUBLISHED &&
        listing.status !== ListingStatus.PAUSED
      ) {
        throw new ConflictException('This listing cannot be marked as rented');
      }

      const selectedApplication = await tx.application.findUnique({
        where: { id: dto.selectedApplicationId },
      });

      if (
        !selectedApplication ||
        selectedApplication.listingId !== id ||
        selectedApplication.status !== ApplicationStatus.ACTIVE
      ) {
        throw new ConflictException(
          'The selected application is not valid for this listing',
        );
      }

      const nonSelectedIds = (
        await tx.application.findMany({
          where: {
            listingId: id,
            id: { not: dto.selectedApplicationId },
            status: {
              in: [ApplicationStatus.ACTIVE, ApplicationStatus.WAITING],
            },
          },
          select: { id: true },
        })
      ).map((a) => a.id);

      if (nonSelectedIds.length > 0) {
        await tx.application.updateMany({
          where: { id: { in: nonSelectedIds } },
          data: {
            status: ApplicationStatus.REJECTED,
            rejectedAt: new Date(),
            publicReason: ApplicationRejectionReason.LISTING_RENTED,
          },
        });
      }

      await tx.application.update({
        where: { id: dto.selectedApplicationId },
        data: { status: ApplicationStatus.ACCEPTED },
      });

      return tx.listing.update({
        where: { id },
        data: { status: ListingStatus.RENTED, rentedAt: new Date() },
      });
    });
  }

  async countByProvider(providerId: string): Promise<number> {
    return this.prisma.listing.count({ where: { providerId } });
  }

  async countDraftsByProvider(providerId: string): Promise<number> {
    return this.prisma.listing.count({
      where: { providerId, status: ListingStatus.DRAFT },
    });
  }

  async findRecentByProvider(
    providerId: string,
    limit: number,
  ): Promise<Listing[]> {
    return this.prisma.listing.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  toListingResponse(
    listing: ListingWithImages,
    options: { exposeExactAddress?: boolean } = {},
  ): ListingResponseDto {
    return new ListingResponseDto(listing, options);
  }

  toListingResponses(
    listings: readonly ListingWithImages[],
    options: { exposeExactAddress?: boolean } = {},
  ): ListingResponseDto[] {
    return listings.map((listing) => this.toListingResponse(listing, options));
  }

  toProviderListingOverviewResponses(
    listings: readonly ListingWithActiveApplicationsCount[],
    options: { exposeExactAddress?: boolean } = {},
  ): ProviderListingOverviewResponseDto[] {
    return listings.map(
      (listing) => new ProviderListingOverviewResponseDto(listing, options),
    );
  }

  async isProfileCompleteForUser(userId: string): Promise<boolean> {
    const profile = await this.prisma.applicantProfile.findUnique({
      where: { applicantId: userId },
    });

    return this.eligibilityService.isProfileComplete(profile);
  }

  async findPublishedForApplicant(
    query: ApplicantListingsQueryDto,
    applicantUser: SafeUser | null,
    res?: { setHeader(name: string, value: string): void },
  ): Promise<ApplicantListingsPageDto> {
    const sort: DiscoverySort = query.sort ?? 'newest';
    const take = Math.min(
      query.limit ?? DISCOVERY_PAGE_SIZE_DEFAULT,
      DISCOVERY_PAGE_SIZE_MAX,
    );

    const isApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE;

    let profile: ApplicantProfile | null = null;

    if (isApplicant) {
      profile = await this.prisma.applicantProfile.findUnique({
        where: { applicantId: applicantUser.id },
      });
    }

    const evaluationTimestamp = new Date();
    const baseWhere = this.buildDiscoveryWhere(query, sort, profile);

    const [total, listings] = await this.prisma.$transaction(
      async (tx) => {
        const count = await tx.listing.count({ where: baseWhere });
        const results = await tx.listing.findMany({
          where: baseWhere,
          orderBy: getSortOrder(sort),
          take: take + 1,
          select: this.getDiscoverySelect(),
        });
        return [count, results];
      },
      { isolationLevel: 'RepeatableRead' },
    );

    const hasMore = listings.length > take;
    const items = hasMore ? listings.slice(0, take) : listings;

    const profileMatchForListing = (listing: {
      minimumHouseholdNetIncome: number | null;
      schufaRequired: boolean;
      incomeProofRequired: boolean;
      suitableForPeopleCount: number | null;
      petsPolicy: string | null;
      smokingPolicy: string | null;
    }): ProfileMatch => {
      if (!isApplicant) {
        return ProfileMatch.UNKNOWN;
      }

      if (!this.eligibilityService.isProfileComplete(profile)) {
        return ProfileMatch.PROFILE_INCOMPLETE;
      }

      const result = this.eligibilityService.evaluateCriteria(listing, profile);
      return result.canApply ? ProfileMatch.MATCH : ProfileMatch.NO_MATCH;
    };

    const summaries = items.map(
      (listing) =>
        new ApplicantListingSummaryDto(
          listing as ApplicantListingSummarySource,
          profileMatchForListing(listing),
          evaluationTimestamp,
        ),
    );

    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(sort, items[items.length - 1])
        : null;

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    return new ApplicantListingsPageDto(summaries, nextCursor, total);
  }

  async findPublishedDetailForApplicant(
    id: string,
    applicantUser: SafeUser | null,
    res?: { setHeader(name: string, value: string): void },
  ): Promise<ApplicantListingDetailDto> {
    const listing = await this.prisma.listing.findFirst({
      where: {
        id,
        status: ListingStatus.PUBLISHED,
        publishedAt: { not: null },
      },
      select: {
        id: true,
        title: true,
        city: true,
        zip: true,
        district: true,
        street: true,
        showExactAddress: true,
        objectType: true,
        livingArea: true,
        rooms: true,
        bedrooms: true,
        coldRent: true,
        additionalCosts: true,
        deposit: true,
        depositMonths: true,
        availableFrom: true,
        shortDescription: true,
        minimumHouseholdNetIncome: true,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: true,
        petsPolicy: true,
        smokingPolicy: true,
        publishedAt: true,
        images: {
          select: { secureUrl: true, position: true, isCover: true },
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    const evaluationTimestamp = new Date();

    const isApplicant =
      applicantUser?.role === Role.APPLICANT &&
      applicantUser.status === UserStatus.ACTIVE;

    let profileMatch = ProfileMatch.UNKNOWN;

    if (isApplicant) {
      const profile = await this.prisma.applicantProfile.findUnique({
        where: { applicantId: applicantUser.id },
      });

      if (!this.eligibilityService.isProfileComplete(profile)) {
        profileMatch = ProfileMatch.PROFILE_INCOMPLETE;
      } else {
        const result = this.eligibilityService.evaluateCriteria(
          listing,
          profile,
        );
        profileMatch = result.canApply
          ? ProfileMatch.MATCH
          : ProfileMatch.NO_MATCH;
      }
    }

    if (res) {
      res.setHeader('Vary', 'Cookie');
      res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    }

    return new ApplicantListingDetailDto(
      listing,
      profileMatch,
      evaluationTimestamp,
    );
  }

  private getDiscoverySelect(): Prisma.ListingSelect {
    return {
      id: true,
      title: true,
      city: true,
      zip: true,
      district: true,
      objectType: true,
      livingArea: true,
      rooms: true,
      bedrooms: true,
      coldRent: true,
      additionalCosts: true,
      deposit: true,
      depositMonths: true,
      availableFrom: true,
      shortDescription: true,
      minimumHouseholdNetIncome: true,
      schufaRequired: true,
      incomeProofRequired: true,
      suitableForPeopleCount: true,
      petsPolicy: true,
      smokingPolicy: true,
      publishedAt: true,
      images: {
        select: { secureUrl: true, position: true, isCover: true },
        orderBy: { position: 'asc' },
      },
    };
  }

  private buildDiscoveryWhere(
    query: ApplicantListingsQueryDto,
    sort: DiscoverySort,
    profile: ApplicantProfile | null,
  ): Prisma.ListingWhereInput {
    const conditions: Prisma.ListingWhereInput[] = [
      { status: ListingStatus.PUBLISHED },
      { publishedAt: { not: null } },
    ];

    if (query.city) {
      conditions.push({
        city: { equals: query.city, mode: 'insensitive' },
      });
    }

    if (query.minRent !== undefined || query.maxRent !== undefined) {
      const coldRent: Prisma.FloatNullableFilter<'Listing'> = {};

      if (query.minRent !== undefined) {
        coldRent.gte = query.minRent;
      }

      if (query.maxRent !== undefined) {
        coldRent.lte = query.maxRent;
      }

      conditions.push({ coldRent });
    }

    if (query.minRooms !== undefined || query.maxRooms !== undefined) {
      const rooms: Prisma.FloatNullableFilter<'Listing'> = {};

      if (query.minRooms !== undefined) {
        rooms.gte = query.minRooms;
      }

      if (query.maxRooms !== undefined) {
        rooms.lte = query.maxRooms;
      }

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

      conditions.push({
        availableFrom: { not: null },
      });
      conditions.push({
        availableFrom: { lt: berlinMidnight },
      });
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
      conditions.push({
        petsPolicy: query.petsPolicy,
      });
    }

    if (query.onlyMatching && profile) {
      conditions.push(this.eligibilityService.buildHardMatchWhere(profile));
    }

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);

      if (!cursor) {
        throw new BadRequestException('Invalid cursor');
      }

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

        conditions.push({
          OR: [
            {
              publishedAt: { lt: new Date(newestCursor.publishedAt) },
            },
            {
              publishedAt: new Date(newestCursor.publishedAt),
              id: { lt: newestCursor.id },
            },
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

        if (isAsc) {
          conditions.push({
            OR: [
              { [field]: { gt: sortedCursor.value } },
              {
                [field]: sortedCursor.value,
                id: { gt: sortedCursor.id },
              },
            ],
          });
        } else {
          conditions.push({
            OR: [
              { [field]: { lt: sortedCursor.value } },
              {
                [field]: sortedCursor.value,
                id: { lt: sortedCursor.id },
              },
            ],
          });
        }
      }
    }

    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  }

  private async createWithImage(
    providerId: string,
    dto: CreateListingDto,
    file: Express.Multer.File,
  ): Promise<Listing> {
    const listingId = randomUUID();
    const uploaded = await this.uploadListingImage(listingId, file);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const listing = await tx.listing.create({
          data: {
            id: listingId,
            ...this.buildCreateData(providerId, dto),
            photos: [uploaded.secure_url],
          },
        });

        await tx.listingImage.create({
          data: {
            listingId,
            publicId: uploaded.public_id,
            secureUrl: uploaded.secure_url,
            position: 0,
            isCover: true,
          },
        });

        return listing;
      });
    } catch (err) {
      await this.deleteUploadedAssetAfterFailure(uploaded.public_id);
      throw err;
    }
  }

  private uploadListingImage(
    listingId: string,
    file: Express.Multer.File,
  ): Promise<UploadApiResponse> {
    const folder = `${this.config.get('CLOUDINARY_FOLDER')}/listings/${listingId}`;
    return this.cloudinaryService.uploadBuffer(file.buffer, folder);
  }

  private async deleteUploadedAssetAfterFailure(
    publicId: string,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteByPublicId(publicId);
    } catch (err) {
      this.logger.error(
        'Failed to delete Cloudinary asset after database failure',
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private buildCreateData(
    providerId: string,
    dto: CreateListingDto,
  ): Prisma.ListingUncheckedCreateInput {
    const draftData = this.stripEmptyValues({
      providerId,
      objectType: dto.objectType,
      city: dto.city,
      zip: dto.zip,
      street: dto.street,
      district: dto.district,
      showExactAddress: dto.showExactAddress,
      livingArea: dto.livingArea,
      rooms: dto.rooms,
      bedrooms: dto.bedrooms,
      coldRent: dto.coldRent,
      additionalCosts: dto.additionalCosts,
      deposit: dto.deposit,
      depositMonths: dto.depositMonths,
      availableFrom: dto.availableFrom
        ? new Date(dto.availableFrom)
        : undefined,
      title: dto.title,
      shortDescription: dto.shortDescription,
      minimumHouseholdNetIncome: dto.minimumHouseholdNetIncome,
      schufaRequired: dto.schufaRequired,
      incomeProofRequired: dto.incomeProofRequired,
      suitableForPeopleCount: dto.suitableForPeopleCount,
      petsPolicy: dto.petsPolicy,
      smokingPolicy: dto.smokingPolicy,
    });

    return {
      providerId,
      ...draftData,
      ...this.buildCreateDepositData(dto),
    };
  }

  private hasMeaningfulDraftData(dto: CreateListingDto): boolean {
    return Object.entries(dto).some(([key, value]) => {
      if (value === undefined || value === null) {
        return false;
      }

      if (key === 'depositMonths' && value === DEFAULT_DEPOSIT_MONTHS) {
        return false;
      }

      if (typeof value === 'string') {
        return value.trim().length > 0;
      }

      if (typeof value === 'boolean') {
        return value;
      }

      return true;
    });
  }

  private buildUpdateData(
    dto: UpdateListingDto,
    listing: Listing,
  ): Prisma.ListingUncheckedUpdateInput {
    this.assertBedroomsNotGreaterThanRooms(dto);

    const { availableFrom, ...rest } = dto;
    const draftData = this.stripEmptyValues(
      {
        ...rest,
        availableFrom:
          availableFrom !== undefined ? new Date(availableFrom) : undefined,
      },
      ELIGIBILITY_CRITERIA_FIELDS,
    );

    return {
      ...draftData,
      ...this.buildUpdateDepositData(dto, listing),
    };
  }

  private buildCreateDepositData(
    dto: CreateListingDto,
  ): Partial<
    Pick<Prisma.ListingUncheckedCreateInput, 'deposit' | 'depositMonths'>
  > {
    const depositMonths = dto.depositMonths ?? DEFAULT_DEPOSIT_MONTHS;
    this.assertDepositMonthsAllowed(depositMonths);

    if (dto.deposit !== undefined && dto.coldRent === undefined) {
      throw new BadRequestException(
        'coldRent is required when deposit is provided',
      );
    }

    if (dto.coldRent === undefined) {
      return dto.depositMonths === undefined
        ? {}
        : { depositMonths: dto.depositMonths };
    }

    const deposit = this.calculateDeposit(dto.coldRent, depositMonths);
    this.assertDepositMatchesCalculation(dto.deposit, deposit);

    return { deposit, depositMonths };
  }

  private buildUpdateDepositData(
    dto: UpdateListingDto,
    listing: Listing,
  ): Partial<
    Pick<Prisma.ListingUncheckedUpdateInput, 'deposit' | 'depositMonths'>
  > {
    const coldRent = dto.coldRent ?? listing.coldRent;
    const depositMonths = dto.depositMonths ?? listing.depositMonths;
    this.assertDepositMonthsAllowed(depositMonths);
    const touchesDepositFields =
      dto.coldRent !== undefined ||
      dto.depositMonths !== undefined ||
      dto.deposit !== undefined;

    if (!touchesDepositFields) {
      return {};
    }

    if (dto.deposit !== undefined && coldRent === null) {
      throw new BadRequestException(
        'coldRent is required when deposit is provided',
      );
    }

    if (coldRent === null) {
      return dto.depositMonths === undefined
        ? {}
        : { depositMonths: dto.depositMonths };
    }

    const deposit = this.calculateDeposit(coldRent, depositMonths);
    this.assertDepositMatchesCalculation(dto.deposit, deposit);

    return { deposit, depositMonths };
  }

  private calculateDeposit(coldRent: number, depositMonths: number): number {
    return Math.round(coldRent * depositMonths * 100) / 100;
  }

  private assertDepositMonthsAllowed(depositMonths: number): void {
    if (
      !Number.isInteger(depositMonths) ||
      depositMonths < MIN_DEPOSIT_MONTHS ||
      depositMonths > MAX_DEPOSIT_MONTHS
    ) {
      throw new BadRequestException('depositMonths must be 1, 2, or 3');
    }
  }

  private assertDepositMatchesCalculation(
    providedDeposit: number | undefined,
    calculatedDeposit: number,
  ): void {
    if (providedDeposit === undefined) {
      return;
    }

    if (
      Math.abs(providedDeposit - calculatedDeposit) > DEPOSIT_AMOUNT_TOLERANCE
    ) {
      throw new BadRequestException(
        'deposit must equal coldRent multiplied by depositMonths',
      );
    }
  }

  private stripEmptyValues<T extends Record<string, unknown>>(
    data: T,
    preserveNullKeys: readonly string[] = [],
  ) {
    return Object.fromEntries(
      Object.entries(data).filter(([key, value]) => {
        if (
          value === undefined ||
          (value === null && !preserveNullKeys.includes(key))
        ) {
          return false;
        }

        if (typeof value === 'string' && value.trim().length === 0) {
          return false;
        }

        return true;
      }),
    ) as Partial<T>;
  }

  private assertBedroomsNotGreaterThanRooms(
    dto: CreateListingDto | UpdateListingDto,
  ): void {
    const { rooms, bedrooms } = dto;

    if (rooms === undefined || rooms === null) {
      return;
    }

    if (bedrooms === undefined || bedrooms === null) {
      return;
    }

    if (typeof rooms !== 'number' || typeof bedrooms !== 'number') {
      return;
    }

    if (bedrooms > rooms) {
      throw new BadRequestException('bedrooms must not be greater than rooms');
    }
  }
}
