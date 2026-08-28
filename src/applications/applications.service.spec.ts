import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type {
  ApplicantProfile,
  Application,
  Listing,
  Prisma,
} from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityResponseDto } from '../eligibility/dto/eligibility-response.dto';
import { EligibilityService } from '../eligibility/eligibility.service';
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
  district: null,
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
  rentedAt: null,
  ...overrides,
});

const makeRawApplication = (
  overrides: Partial<Application> = {},
): Application => ({
  id: APPLICATION_ID,
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.ACTIVE,
  rejectedAt: null,
  publicReason: null,
  queueOrder: BigInt(1),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let eligibilityService: jest.Mocked<EligibilityService>;
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
      update: jest.MockedFunction<(args?: unknown) => Promise<Application>>;
      findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
      findFirst: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
      findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    };
    applicantProfile: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicantProfile | null>
      >;
    };
    $transaction: jest.MockedFunction<
      (
        callback: (transaction: typeof prismaMock) => Promise<Application>,
        options?: unknown,
      ) => Promise<Application>
    >;
    $queryRaw: jest.MockedFunction<(query: unknown) => Promise<unknown>>;
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
        update: jest.fn<(args?: unknown) => Promise<Application>>(),
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
      },
      applicantProfile: {
        findUnique:
          jest.fn<(args?: unknown) => Promise<ApplicantProfile | null>>(),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.application.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: EligibilityService,
          useValue: { check: jest.fn(), evaluate: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
    eligibilityService = module.get(EligibilityService);
    eligibilityService.evaluate.mockReturnValue(
      new EligibilityResponseDto(true, [], [], new Date()),
    );
  });

  describe('apply', () => {
    it('rejects an application when eligibility fails', async () => {
      eligibilityService.evaluate.mockReturnValue(
        new EligibilityResponseDto(
          false,
          ['household_income_below_requirement'],
          [],
          new Date(),
        ),
      );
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());

      await expect(
        service.apply(LISTING_ID, APPLICANT_ID),
      ).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: {
          message: 'Applicant is not eligible for this listing',
          canApply: false,
          reasons: ['household_income_below_requirement'],
          warnings: [],
        },
      });
      expect(eligibilityService.evaluate).toHaveBeenCalled();
      expect(prismaMock.application.count).not.toHaveBeenCalled();
      expect(prismaMock.application.create).not.toHaveBeenCalled();
    });

    it('creates an ACTIVE application when fewer than 5 active applications exist', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication({
        status: ApplicationStatus.ACTIVE,
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(2);
      prismaMock.application.create.mockResolvedValue(application);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
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

    it('retries serializable transaction conflicts', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication();
      const conflict = new PrismaClientKnownRequestError(
        'Transaction conflict',
        { code: 'P2034', clientVersion: '7.0.0' },
      );
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(0);
      prismaMock.application.create.mockResolvedValue(application);
      prismaMock.$transaction.mockRejectedValueOnce(conflict);
      prismaMock.$transaction.mockImplementationOnce(async (callback) =>
        callback(prismaMock),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).resolves.toBe(
        application,
      );
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });

    it('retries adapter serialization conflicts', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(0);
      prismaMock.application.create.mockResolvedValue(application);
      prismaMock.$transaction.mockRejectedValueOnce({
        code: 'P2034',
        meta: {
          driverAdapterError: {
            cause: { originalCode: '40001' },
          },
        },
      });
      prismaMock.$transaction.mockImplementationOnce(async (callback) =>
        callback(prismaMock),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).resolves.toBe(
        application,
      );
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });

    it('creates a WAITING application when 5 active applications already exist', async () => {
      const listing = makeRawListing();
      const application = makeRawApplication({
        status: ApplicationStatus.WAITING,
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(5);
      prismaMock.application.create.mockResolvedValue(application);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(prismaMock.application.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ApplicationStatus.WAITING,
          }),
        }),
      );
      expect(result.status).toBe(ApplicationStatus.WAITING);
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

    it('throws ConflictException when a live application already exists', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(
        makeRawApplication({ status: ApplicationStatus.ACTIVE }),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.application.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when a WAITING application already exists', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(
        makeRawApplication({ status: ApplicationStatus.WAITING }),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.application.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when a REJECTED application already exists', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(
        makeRawApplication({ status: ApplicationStatus.REJECTED }),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.application.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when an ACCEPTED application already exists', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(
        makeRawApplication({ status: ApplicationStatus.ACCEPTED }),
      );

      await expect(service.apply(LISTING_ID, APPLICANT_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.application.create).not.toHaveBeenCalled();
    });

    it('still maps a Prisma unique constraint violation to ConflictException for races', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(null);
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

    it('creates a new application when the previous one is WITHDRAWN', async () => {
      const listing = makeRawListing();
      const reapplied = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000005',
        status: ApplicationStatus.ACTIVE,
        queueOrder: BigInt(2),
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(null);
      prismaMock.application.count.mockResolvedValue(0);
      prismaMock.application.create.mockResolvedValue(reapplied);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(result.id).toBe(reapplied.id);
      expect(result.status).toBe(ApplicationStatus.ACTIVE);
      expect(result.queueOrder).toBe(reapplied.queueOrder);
      expect(prismaMock.application.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            listingId: LISTING_ID,
            applicantId: APPLICANT_ID,
            status: ApplicationStatus.ACTIVE,
          }),
        }),
      );
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('recalculates WAITING status from the current listing state when re-applying', async () => {
      const listing = makeRawListing();
      const reapplied = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000005',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(7),
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.findFirst.mockResolvedValue(null);
      prismaMock.application.count.mockResolvedValue(5);
      prismaMock.application.create.mockResolvedValue(reapplied);

      const result = await service.apply(LISTING_ID, APPLICANT_ID);

      expect(result.status).toBe(ApplicationStatus.WAITING);
      expect(prismaMock.application.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ApplicationStatus.WAITING,
          }),
        }),
      );
    });
  });

  describe('withdraw', () => {
    it('withdraws an active application and promotes the waiting queue', async () => {
      const application = makeRawApplication({
        status: ApplicationStatus.ACTIVE,
      });
      const withdrawn = makeRawApplication({
        status: ApplicationStatus.WITHDRAWN,
      });
      prismaMock.application.findUnique
        .mockResolvedValueOnce({ listingId: LISTING_ID })
        .mockResolvedValueOnce(application);
      prismaMock.application.update.mockResolvedValue(withdrawn);
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.findMany.mockResolvedValue([]);

      const result = await service.withdraw(APPLICATION_ID, APPLICANT_ID);

      expect(result.status).toBe(ApplicationStatus.WITHDRAWN);
      expect(prismaMock.application.update).toHaveBeenCalledWith({
        where: { id: APPLICATION_ID },
        data: { status: ApplicationStatus.WITHDRAWN },
      });
      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { listingId: LISTING_ID, status: ApplicationStatus.WAITING },
        }),
      );
      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    it('withdraws a waiting application without promoting the queue', async () => {
      const application = makeRawApplication({
        status: ApplicationStatus.WAITING,
      });
      const withdrawn = makeRawApplication({
        status: ApplicationStatus.WITHDRAWN,
      });
      prismaMock.application.findUnique
        .mockResolvedValueOnce({ listingId: LISTING_ID })
        .mockResolvedValueOnce(application);
      prismaMock.application.update.mockResolvedValue(withdrawn);

      await expect(
        service.withdraw(APPLICATION_ID, APPLICANT_ID),
      ).resolves.toEqual(withdrawn);
      expect(prismaMock.listing.findUnique).not.toHaveBeenCalled();
      expect(prismaMock.application.findMany).not.toHaveBeenCalled();
    });

    it('does not reveal an application owned by another applicant', async () => {
      prismaMock.application.findUnique
        .mockResolvedValueOnce({ listingId: LISTING_ID })
        .mockResolvedValueOnce(
          makeRawApplication({
            applicantId: '00000000-0000-4000-8000-000000000099',
          }),
        );

      await expect(
        service.withdraw(APPLICATION_ID, APPLICANT_ID),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('handles repeated withdrawal idempotently', async () => {
      const withdrawn = makeRawApplication({
        status: ApplicationStatus.WITHDRAWN,
      });
      prismaMock.application.findUnique
        .mockResolvedValueOnce({ listingId: LISTING_ID })
        .mockResolvedValueOnce(withdrawn);

      await expect(
        service.withdraw(APPLICATION_ID, APPLICANT_ID),
      ).resolves.toEqual(withdrawn);
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('rejects applications that are not active or waiting', async () => {
      const rejected = makeRawApplication({
        status: ApplicationStatus.REJECTED,
      });
      prismaMock.application.findUnique
        .mockResolvedValueOnce({ listingId: LISTING_ID })
        .mockResolvedValueOnce(rejected);

      await expect(
        service.withdraw(APPLICATION_ID, APPLICANT_ID),
      ).rejects.toThrow(ConflictException);
      expect(prismaMock.application.update).not.toHaveBeenCalled();
      expect(prismaMock.application.findMany).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('rejects an ACTIVE application with NOT_SELECTED', async () => {
      const application = makeRawApplication({
        status: ApplicationStatus.ACTIVE,
      });
      const rejected = makeRawApplication({
        status: ApplicationStatus.REJECTED,
        rejectedAt: new Date(),
        publicReason: ApplicationRejectionReason.NOT_SELECTED,
      });
      prismaMock.application.findUnique
        .mockResolvedValueOnce({
          ...application,
          listing: {
            id: LISTING_ID,
            providerId: PROVIDER_ID,
            status: ListingStatus.PUBLISHED,
          },
        })
        .mockResolvedValueOnce(application);
      prismaMock.application.update.mockResolvedValue(rejected);
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.findMany.mockResolvedValue([]);

      const result = await service.reject(APPLICATION_ID, PROVIDER_ID);

      expect(result.status).toBe(ApplicationStatus.REJECTED);
      expect(prismaMock.application.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: APPLICATION_ID },
          data: expect.objectContaining({
            status: ApplicationStatus.REJECTED,
            rejectedAt: expect.any(Date),
          }),
        }),
      );
      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    it('hides applications belonging to other providers', async () => {
      prismaMock.application.findUnique.mockResolvedValueOnce({
        id: APPLICATION_ID,
        listing: {
          id: LISTING_ID,
          providerId: '00000000-0000-4000-8000-000000000099',
          status: ListingStatus.PUBLISHED,
        },
      });

      await expect(service.reject(APPLICATION_ID, PROVIDER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('rejects applications that are not ACTIVE', async () => {
      const application = makeRawApplication({
        status: ApplicationStatus.REJECTED,
      });
      prismaMock.application.findUnique.mockResolvedValueOnce({
        ...application,
        listing: {
          id: LISTING_ID,
          providerId: PROVIDER_ID,
          status: ListingStatus.PUBLISHED,
        },
      });

      await expect(service.reject(APPLICATION_ID, PROVIDER_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });
  });

  describe('findAllByProvider', () => {
    it('returns non-waiting applications for all listings owned by the provider', async () => {
      const applications = [makeRawApplication()];
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findAllByProvider(PROVIDER_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            listing: { providerId: PROVIDER_ID },
            status: { not: ApplicationStatus.WAITING },
          },
        }),
      );
      expect(result).toEqual(applications);
    });
  });

  describe('findAllByListing', () => {
    it('returns non-waiting applications for a listing owned by the provider', async () => {
      const listing = makeRawListing();
      const applications = [makeRawApplication()];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(applications);

      const result = await service.findAllByListing(LISTING_ID, PROVIDER_ID);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            listingId: LISTING_ID,
            listing: { providerId: PROVIDER_ID },
            status: { not: ApplicationStatus.WAITING },
          },
        }),
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

  describe('findWaitingCountByListing', () => {
    it('returns only the waiting count for an owned listing', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(3);

      await expect(
        service.findWaitingCountByListing(LISTING_ID, PROVIDER_ID),
      ).resolves.toBe(3);
      expect(prismaMock.application.count).toHaveBeenCalledWith({
        where: { listingId: LISTING_ID, status: ApplicationStatus.WAITING },
      });
    });
  });

  describe('findActiveByListing', () => {
    it('returns ACTIVE applications with provider-safe applicant data for an owned listing', async () => {
      const listing = makeRawListing();
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'Anna Applicant',
            profile: {
              peopleCount: 2,
              hasPets: false,
              isSmoker: false,
            },
          },
        },
      ];
      const expected = [
        {
          id: rawApplications[0].id,
          listingId: rawApplications[0].listingId,
          status: rawApplications[0].status,
          applicant: {
            name: 'Anna Applicant',
            profile: {
              peopleCount: 2,
            },
          },
          warnings: [],
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      await expect(
        service.findActiveByListing(LISTING_ID, PROVIDER_ID),
      ).resolves.toEqual(expected);
      expect(prismaMock.listing.findFirst).toHaveBeenCalledWith({
        where: { id: LISTING_ID, providerId: PROVIDER_ID },
        select: { id: true, petsPolicy: true, smokingPolicy: true },
      });
      expect(prismaMock.application.findMany).toHaveBeenCalledWith({
        where: {
          listingId: LISTING_ID,
          status: ApplicationStatus.ACTIVE,
          listing: { providerId: PROVIDER_ID },
        },
        orderBy: { createdAt: 'asc' },
        take: 5,
        select: {
          id: true,
          listingId: true,
          status: true,
          applicant: {
            select: {
              name: true,
              profile: {
                select: {
                  peopleCount: true,
                  hasPets: true,
                  isSmoker: true,
                },
              },
            },
          },
        },
      });
    });

    it('returns arrangement warnings derived from applicant profile and listing policy', async () => {
      const listing = makeRawListing({
        petsPolicy: PetsPolicy.BY_ARRANGEMENT,
        smokingPolicy: SmokingPolicy.BY_ARRANGEMENT,
      });
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'Pet Owner Smoker',
            profile: {
              peopleCount: 2,
              hasPets: true,
              isSmoker: true,
            },
          },
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(result[0]?.warnings).toEqual([
        'pets_by_arrangement',
        'smoking_by_arrangement',
      ]);
      expect(result[0]?.applicant.profile).not.toHaveProperty('hasPets');
      expect(result[0]?.applicant.profile).not.toHaveProperty('isSmoker');
    });

    it('returns only the pets_by_arrangement warning', async () => {
      const listing = makeRawListing({
        petsPolicy: PetsPolicy.BY_ARRANGEMENT,
        smokingPolicy: SmokingPolicy.ALLOWED,
      });
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'Pet Owner',
            profile: {
              peopleCount: 2,
              hasPets: true,
              isSmoker: false,
            },
          },
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(result[0]?.warnings).toEqual(['pets_by_arrangement']);
    });

    it('returns only the smoking_by_arrangement warning', async () => {
      const listing = makeRawListing({
        petsPolicy: PetsPolicy.ALLOWED,
        smokingPolicy: SmokingPolicy.BY_ARRANGEMENT,
      });
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'Smoker',
            profile: {
              peopleCount: 1,
              hasPets: false,
              isSmoker: true,
            },
          },
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(result[0]?.warnings).toEqual(['smoking_by_arrangement']);
    });

    it('returns empty warnings when the listing does not require arrangement', async () => {
      const listing = makeRawListing({
        petsPolicy: PetsPolicy.ALLOWED,
        smokingPolicy: SmokingPolicy.ALLOWED,
      });
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'No Arrangement Needed',
            profile: {
              peopleCount: 1,
              hasPets: true,
              isSmoker: true,
            },
          },
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(result[0]?.warnings).toEqual([]);
    });

    it('returns empty warnings when the applicant has no profile', async () => {
      const listing = makeRawListing({
        petsPolicy: PetsPolicy.BY_ARRANGEMENT,
        smokingPolicy: SmokingPolicy.BY_ARRANGEMENT,
      });
      const rawApplications = [
        {
          ...makeRawApplication(),
          applicant: {
            name: 'No Profile',
            profile: null,
          },
        },
      ];
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.application.findMany.mockResolvedValue(rawApplications);

      const result = await service.findActiveByListing(LISTING_ID, PROVIDER_ID);

      expect(result[0]?.warnings).toEqual([]);
    });

    it('throws NotFoundException when listing does not belong to the provider', async () => {
      prismaMock.listing.findFirst.mockResolvedValue(null);

      await expect(
        service.findActiveByListing(LISTING_ID, PROVIDER_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('promoteWaitingApplications', () => {
    it('promotes waiting applications in creation order after rechecking eligibility', async () => {
      const listing = makeRawListing();
      const firstWaiting = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000005',
        applicantId: '00000000-0000-4000-8000-000000000006',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(2),
        createdAt: new Date('2024-01-01'),
      });
      const secondWaiting = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000007',
        applicantId: '00000000-0000-4000-8000-000000000008',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(3),
        createdAt: new Date('2024-01-02'),
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.findMany.mockResolvedValue([
        firstWaiting,
        secondWaiting,
      ]);
      prismaMock.application.update.mockResolvedValue(
        makeRawApplication({ status: ApplicationStatus.ACTIVE }),
      );
      eligibilityService.evaluate
        .mockReturnValueOnce(
          new EligibilityResponseDto(false, [], [], new Date()),
        )
        .mockReturnValueOnce(
          new EligibilityResponseDto(true, [], [], new Date()),
        );

      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(1);
      expect(prismaMock.application.findMany).toHaveBeenCalledWith({
        where: { listingId: LISTING_ID, status: ApplicationStatus.WAITING },
        orderBy: { queueOrder: 'asc' },
        take: 50,
        select: { id: true, applicantId: true, queueOrder: true },
      });
      expect(prismaMock.application.update).toHaveBeenCalledWith({
        where: { id: secondWaiting.id },
        data: { status: ApplicationStatus.ACTIVE },
      });
    });

    it('promotes in FIFO queue order and never ranks by applicant attributes', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(3);
      const waiting = [BigInt(7), BigInt(8), BigInt(9)].map((queueOrder, i) =>
        makeRawApplication({
          id: `00000000-0000-4000-8000-00000000001${i}`,
          applicantId: `00000000-0000-4000-8000-00000000002${i}`,
          status: ApplicationStatus.WAITING,
          queueOrder,
        }),
      );
      prismaMock.application.findMany.mockResolvedValue(waiting);
      prismaMock.application.update.mockResolvedValue(makeRawApplication());

      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(2);

      expect(prismaMock.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { queueOrder: 'asc' } }),
      );
      expect(prismaMock.application.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { id: waiting[0].id } }),
      );
      expect(prismaMock.application.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: waiting[1].id } }),
      );
    });

    it('rechecks eligibility with the current listing and profile before each promotion', async () => {
      const listing = makeRawListing();
      const waiting = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000030',
        applicantId: '00000000-0000-4000-8000-000000000031',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(4),
      });
      prismaMock.listing.findUnique.mockResolvedValue(listing);
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.findMany.mockResolvedValue([waiting]);
      prismaMock.application.update.mockResolvedValue(makeRawApplication());
      prismaMock.applicantProfile.findUnique.mockResolvedValue(null);

      await service.promoteWaitingApplications(LISTING_ID);

      expect(eligibilityService.evaluate).toHaveBeenCalledWith(listing, null);
      expect(prismaMock.applicantProfile.findUnique).toHaveBeenCalledWith({
        where: { applicantId: waiting.applicantId },
      });
    });

    it('never promotes beyond the five active applications limit', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.findMany.mockResolvedValue(
        [BigInt(11), BigInt(12), BigInt(13), BigInt(14)].map((queueOrder, i) =>
          makeRawApplication({
            id: `00000000-0000-4000-8000-00000000004${i}`,
            applicantId: `00000000-0000-4000-8000-00000000005${i}`,
            status: ApplicationStatus.WAITING,
            queueOrder,
          }),
        ),
      );
      prismaMock.application.update.mockResolvedValue(makeRawApplication());

      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(1);
      expect(prismaMock.application.update).toHaveBeenCalledTimes(1);
    });

    it('promotes nothing when the listing is already at the active limit', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(5);

      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(0);
      expect(prismaMock.application.findMany).not.toHaveBeenCalled();
      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('runs inside a serializable transaction that locks the listing', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(5);

      await service.promoteWaitingApplications(LISTING_ID);

      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
      expect(prismaMock.$queryRaw).toHaveBeenCalled();
    });

    it('retries serialization conflicts instead of failing the promotion', async () => {
      prismaMock.listing.findUnique.mockResolvedValue(makeRawListing());
      prismaMock.application.count.mockResolvedValue(5);
      const conflict = new PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: '6.0.0',
      });
      prismaMock.$transaction.mockRejectedValueOnce(conflict);

      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(0);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });

    it('promotes nothing when the listing no longer exists or is not published', async () => {
      prismaMock.listing.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(0);

      prismaMock.listing.findUnique.mockResolvedValueOnce(
        makeRawListing({ status: ListingStatus.ARCHIVED }),
      );
      await expect(
        service.promoteWaitingApplications(LISTING_ID),
      ).resolves.toBe(0);

      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });
  });

  describe('revalidateActiveAndWaitingApplications', () => {
    const makeProfile = (
      overrides: Partial<ApplicantProfile> = {},
    ): ApplicantProfile => ({
      id: '00000000-0000-4000-8000-000000000100',
      applicantId: APPLICANT_ID,
      householdNetIncome: null,
      incomeProofAvailable: null,
      schufaAvailable: null,
      peopleCount: null,
      adultsCount: null,
      childrenCount: null,
      hasPets: null,
      isSmoker: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      ...overrides,
    });

    const makeApplicationWithListing = (
      applicationOverrides: Partial<Application> = {},
      listing: Listing,
    ): Application & { listing: Listing } => ({
      ...makeRawApplication(applicationOverrides),
      listing,
    });

    const extractLockedListingId = (
      strings: unknown,
      ...values: unknown[]
    ): string | undefined => {
      void strings;
      const firstValue = values[0];
      return typeof firstValue === 'string' ? firstValue : undefined;
    };

    it('leaves eligible ACTIVE applications unchanged', async () => {
      const listing = makeRawListing();
      const application = makeApplicationWithListing(
        { status: ApplicationStatus.ACTIVE },
        listing,
      );
      prismaMock.application.findMany.mockResolvedValue([application]);

      await service.revalidateActiveAndWaitingApplications(
        prismaMock as unknown as Prisma.TransactionClient,
        APPLICANT_ID,
        makeProfile(),
      );

      expect(prismaMock.application.update).not.toHaveBeenCalled();
    });

    it('rejects an ineligible ACTIVE application and promotes the next eligible WAITING applicant', async () => {
      const listing = makeRawListing();
      const activeApplication = makeApplicationWithListing(
        {
          id: '00000000-0000-4000-8000-000000000010',
          status: ApplicationStatus.ACTIVE,
        },
        listing,
      );
      const waitingApplication = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000011',
        applicantId: '00000000-0000-4000-8000-000000000020',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(2),
      });
      prismaMock.application.findMany
        .mockResolvedValueOnce([activeApplication])
        .mockResolvedValueOnce([waitingApplication]);
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.update.mockResolvedValue(makeRawApplication());
      eligibilityService.evaluate
        .mockReturnValueOnce(
          new EligibilityResponseDto(false, [], [], new Date()),
        )
        .mockReturnValueOnce(
          new EligibilityResponseDto(true, [], [], new Date()),
        );

      await service.revalidateActiveAndWaitingApplications(
        prismaMock as unknown as Prisma.TransactionClient,
        APPLICANT_ID,
        makeProfile(),
      );

      expect(prismaMock.application.update).toHaveBeenNthCalledWith(1, {
        where: { id: activeApplication.id },
        data: {
          status: ApplicationStatus.REJECTED,
          rejectedAt: expect.any(Date),
          publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        },
      });
      expect(prismaMock.application.update).toHaveBeenNthCalledWith(2, {
        where: { id: waitingApplication.id },
        data: { status: ApplicationStatus.ACTIVE },
      });
    });

    it('rejects an ineligible WAITING application without promoting', async () => {
      const listing = makeRawListing();
      const waitingApplication = makeApplicationWithListing(
        {
          id: '00000000-0000-4000-8000-000000000012',
          status: ApplicationStatus.WAITING,
        },
        listing,
      );
      prismaMock.application.findMany.mockResolvedValue([waitingApplication]);
      eligibilityService.evaluate.mockReturnValue(
        new EligibilityResponseDto(false, [], [], new Date()),
      );

      await service.revalidateActiveAndWaitingApplications(
        prismaMock as unknown as Prisma.TransactionClient,
        APPLICANT_ID,
        makeProfile(),
      );

      expect(prismaMock.application.update).toHaveBeenCalledWith({
        where: { id: waitingApplication.id },
        data: {
          status: ApplicationStatus.REJECTED,
          rejectedAt: expect.any(Date),
          publicReason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
        },
      });
      expect(prismaMock.application.count).not.toHaveBeenCalled();
    });

    it('promotes waiting applicants in FIFO order when an ACTIVE slot is freed', async () => {
      const listing = makeRawListing();
      const activeApplication = makeApplicationWithListing(
        {
          id: '00000000-0000-4000-8000-000000000013',
          status: ApplicationStatus.ACTIVE,
        },
        listing,
      );
      const firstWaiting = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000014',
        applicantId: '00000000-0000-4000-8000-000000000021',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(2),
      });
      const secondWaiting = makeRawApplication({
        id: '00000000-0000-4000-8000-000000000015',
        applicantId: '00000000-0000-4000-8000-000000000022',
        status: ApplicationStatus.WAITING,
        queueOrder: BigInt(3),
      });
      prismaMock.application.findMany
        .mockResolvedValueOnce([activeApplication])
        .mockResolvedValueOnce([firstWaiting, secondWaiting]);
      prismaMock.application.count.mockResolvedValue(4);
      prismaMock.application.update.mockResolvedValue(makeRawApplication());
      eligibilityService.evaluate
        .mockReturnValueOnce(
          new EligibilityResponseDto(false, [], [], new Date()),
        )
        .mockReturnValueOnce(
          new EligibilityResponseDto(true, [], [], new Date()),
        );

      await service.revalidateActiveAndWaitingApplications(
        prismaMock as unknown as Prisma.TransactionClient,
        APPLICANT_ID,
        makeProfile(),
      );

      expect(prismaMock.application.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: firstWaiting.id } }),
      );
    });

    it('processes multiple listings in deterministic lexicographic order', async () => {
      const listingB = makeRawListing({
        id: '00000000-0000-4000-8000-0000000000b2',
      });
      const listingA = makeRawListing({
        id: '00000000-0000-4000-8000-0000000000a1',
      });
      const applicationOnB = makeApplicationWithListing(
        {
          id: '00000000-0000-4000-8000-000000000030',
          listingId: listingB.id,
          status: ApplicationStatus.ACTIVE,
        },
        listingB,
      );
      const applicationOnA = makeApplicationWithListing(
        {
          id: '00000000-0000-4000-8000-000000000031',
          listingId: listingA.id,
          status: ApplicationStatus.ACTIVE,
        },
        listingA,
      );
      prismaMock.application.findMany.mockResolvedValue([
        applicationOnB,
        applicationOnA,
      ]);
      eligibilityService.evaluate.mockReturnValue(
        new EligibilityResponseDto(true, [], [], new Date()),
      );

      await service.revalidateActiveAndWaitingApplications(
        prismaMock as unknown as Prisma.TransactionClient,
        APPLICANT_ID,
        makeProfile(),
      );

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);

      const lockedListingIds = prismaMock.$queryRaw.mock.calls
        .map((call) => extractLockedListingId(...call))
        .filter((id): id is string => id !== undefined);
      expect(lockedListingIds).toEqual([listingA.id, listingB.id]);
    });
  });
});
