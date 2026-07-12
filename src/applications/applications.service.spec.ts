import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { Application, Listing } from '../generated/prisma/client';
import {
  ApplicationStatus,
  ListingStatus,
  ObjectType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationsService } from './applications.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000001';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000002';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000003';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000004';

const makeRawListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: LISTING_ID,
  providerId: PROVIDER_ID,
  status: ListingStatus.PUBLISHED,
  city: 'Berlin',
  zip: '10115',
  street: null,
  country: 'DE',
  showExactAddress: false,
  objectType: ObjectType.APARTMENT,
  livingArea: null,
  rooms: null,
  bedrooms: null,
  coldRent: null,
  additionalCosts: null,
  deposit: null,
  depositMonths: 2,
  availableFrom: null,
  title: 'Test Listing',
  shortDescription: null,
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: new Date('2024-01-01'),
  ...overrides,
});

const makeRawApplication = (
  overrides: Partial<Application> = {},
): Application => ({
  id: APPLICATION_ID,
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.ACTIVE,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let prismaMock: {
    listing: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<Listing | null>
      >;
      findFirst: jest.MockedFunction<
        (args?: unknown) => Promise<Listing | null>
      >;
    };
    application: {
      count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
      create: jest.MockedFunction<(args?: unknown) => Promise<Application>>;
      findMany: jest.MockedFunction<(args?: unknown) => Promise<Application[]>>;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      listing: {
        findUnique: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
      },
      application: {
        count: jest.fn<(args?: unknown) => Promise<number>>(),
        create: jest.fn<(args?: unknown) => Promise<Application>>(),
        findMany: jest.fn<(args?: unknown) => Promise<Application[]>>(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  describe('apply', () => {
    it('creates an ACTIVE application when fewer than 5 active applications exist', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication({
        status: ApplicationStatus.ACTIVE,
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(2);
      prismaMock.application.create.mockResolvedValue(application);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(prismaMock.application.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            listingId: LISTING_ID,
            applicantId: APPLICANT_ID,
            status: ApplicationStatus.ACTIVE,
          }),
        }),
      );
      expect(result.status).toBe(ApplicationStatus.ACTIVE);
    });

    it('creates a PENDING_QUEUE application when 5 active applications already exist', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication({
        status: ApplicationStatus.PENDING_QUEUE,
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(5);
      prismaMock.application.create.mockResolvedValue(application);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(prismaMock.application.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ApplicationStatus.PENDING_QUEUE,
          }),
        }),
      );
      expect(result.status).toBe(ApplicationStatus.PENDING_QUEUE);
    });

    it('throws NotFoundException when listing does not exist', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(null);

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws UnprocessableEntityException when listing is not PUBLISHED', async () => {
      const listing = makeRawListing({ status: ListingStatus.DRAFT });
      prismaMock.listing.findUnique.mockResolvedValue(listing);

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('throws ConflictException on duplicate application', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(0);
      prismaMock.application.create.mockRejectedValue(
        new PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.0.0',
        }),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findAllByApplicant', () => {
    it('returns applications for the given applicant', async () => {
      const applications = [makeRawApplication()];
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findAllByApplicant(APPLICANT_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { applicantId: APPLICANT_ID },
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(result).toEqual(applications);
    });
  });

  describe('findAllByProvider', () => {
    it('returns applications for all listings owned by the provider', async () => {
      const applications = [makeRawApplication()];
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findAllByProvider(PROVIDER_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { listing: { providerId: PROVIDER_ID } },
        }),
      );
      expect(result).toEqual(applications);
    });
  });

  describe('findAllByListing', () => {
    it('returns all applications for a listing owned by the provider', async () => {
      const listing = makeRawListing();
      const applications = [makeRawApplication()];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findAllByListing(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { listingId: LISTING_ID } }),
      );
      expect(result).toEqual(applications);
    });

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findAllByListing(LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findActiveByListing', () => {
    it('returns only ACTIVE applications for a listing owned by the provider', async () => {
      const listing = makeRawListing();
      const applications = [makeRawApplication()];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { listingId: LISTING_ID, status: ApplicationStatus.ACTIVE },
        }),
      );
      expect(result).toEqual(applications);
    });

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findActiveByListing(LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
