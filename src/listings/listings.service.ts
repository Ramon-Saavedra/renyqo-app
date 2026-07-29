import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { UploadApiResponse } from 'cloudinary';
import type { EnvironmentVariables } from '../config/env.validation';
import type { Listing } from '../generated/prisma/client';
import type { Prisma } from '../generated/prisma/client';
import { ListingStatus } from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
import type { ListingWithImages } from './dto/listing-response.dto';
import type { UpdateListingDto } from './dto/update-listing.dto';

const PUBLISH_REQUIRED_FIELDS = [
  'title',
  'street',
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

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
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

  async findAllByProvider(providerId: string): Promise<Listing[]> {
    return this.prisma.listing.findMany({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
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
