import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Listing } from '../generated/prisma/client';
import { ListingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateListingDto } from './dto/create-listing.dto';
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
  constructor(private readonly prisma: PrismaService) {}

  async create(providerId: string, dto: CreateListingDto): Promise<Listing> {
    return this.prisma.listing.create({
      data: {
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
      },
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

  async countByProvider(providerId: string): Promise<number> {
    return this.prisma.listing.count({ where: { providerId } });
  }
}
