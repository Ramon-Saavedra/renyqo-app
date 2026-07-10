import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { UploadApiResponse } from 'cloudinary';
import type { EnvironmentVariables } from '../config/env.validation';
import type { Application, Listing } from '../generated/prisma/client';
import { ApplicationStatus, ListingStatus } from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateListingDto } from './dto/create-listing.dto';
import { ListingResponseDto } from './dto/listing-response.dto';
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

  async update(
    id: string,
    providerId: string,
    dto: UpdateListingDto,
  ): Promise<Listing> {
    await this.findOneByProvider(id, providerId);
    const { availableFrom, ...rest } = dto;
    return this.prisma.listing.update({
      where: { id },
      data: {
        ...rest,
        ...(availableFrom !== undefined
          ? { availableFrom: new Date(availableFrom) }
          : {}),
      },
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

  async getActiveApplications(
    id: string,
    providerId: string,
  ): Promise<Application[]> {
    await this.findOneByProvider(id, providerId);
    return this.prisma.application.findMany({
      where: { listingId: id, status: ApplicationStatus.ACTIVE },
      orderBy: { createdAt: 'asc' },
    });
  }

  toListingResponse(
    listing: Listing,
    options: { exposeExactAddress?: boolean } = {},
  ): ListingResponseDto {
    return new ListingResponseDto(listing, options);
  }

  toListingResponses(
    listings: readonly Listing[],
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

  private buildCreateData(providerId: string, dto: CreateListingDto) {
    return {
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
    };
  }
}
