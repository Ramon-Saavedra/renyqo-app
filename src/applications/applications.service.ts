import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { Application } from '../generated/prisma/client';
import { ApplicationStatus, ListingStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_APPLICATIONS_LIMIT = 5;

@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(listingId: string, applicantId: string): Promise<Application> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    if (listing.status !== ListingStatus.PUBLISHED) {
      throw new UnprocessableEntityException(
        'This listing is not accepting applications',
      );
    }

    const activeCount = await this.prisma.application.count({
      where: { listingId, status: ApplicationStatus.ACTIVE },
    });

    const status =
      activeCount < ACTIVE_APPLICATIONS_LIMIT
        ? ApplicationStatus.ACTIVE
        : ApplicationStatus.PENDING_QUEUE;

    try {
      return await this.prisma.application.create({
        data: { listingId, applicantId, status },
      });
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('You have already applied to this listing');
      }
      throw err;
    }
  }

  async findAllByApplicant(applicantId: string): Promise<Application[]> {
    return this.prisma.application.findMany({
      where: { applicantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByProvider(providerId: string): Promise<Application[]> {
    return this.prisma.application.findMany({
      where: { listing: { providerId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByListing(
    listingId: string,
    providerId: string,
  ): Promise<Application[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.prisma.application.findMany({
      where: { listingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findActiveByListing(
    listingId: string,
    providerId: string,
  ): Promise<Application[]> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

    return this.prisma.application.findMany({
      where: { listingId, status: ApplicationStatus.ACTIVE },
      orderBy: { createdAt: 'asc' },
    });
  }
}
