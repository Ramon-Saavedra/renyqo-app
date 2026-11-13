import {
  unitProviderOperations,
  UNIT_WORKSPACE_ID,
  UNIT_MEMBERSHIP_ID,
} from '../../test/unit-workspace-authority';
import { ProviderListingAccess } from '../provider-authorization/provider-listing-access';
import { unitProvider } from '../../test/unit-workspace-authority';
import { ApplicationEligibilityAssessmentService } from '../eligibility/application-eligibility-assessment.service';
import { ListingCriteriaRevisionService } from '../eligibility/listing-criteria-revision.service';
import { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import { ViewingLifecycleService } from '../applications/viewing-lifecycle.service';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UploadApiResponse } from 'cloudinary';

import type {
  ApplicantProfile,
  Listing,
  ListingImage,
} from '../generated/prisma/client';
import {
  ListingStatus,
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../generated/prisma/enums';
import { CloudinaryService } from '../listing-images/cloudinary.service';
import { ApplicationActivityService } from '../applications/application-activity.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingsService } from './listings.service';
import { ListingOrderingService } from './listing-ordering.service';
import { ListingInputRules } from './listing-input-rules';
import { ListingResponseMapper } from './listing-response.mapper';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const CLOUDINARY_FOLDER = 'renyqo';

type ListingsTransactionMock = {
  listing: {
    create: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    findFirst: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<Listing | null>
    >;
    update: jest.MockedFunction<(args?: unknown) => Promise<Listing>>;
    count: jest.MockedFunction<(args?: unknown) => Promise<number>>;
    aggregate: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  listingImage: {
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingImage>>;
  };
  application: {
    findUnique: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    findMany: jest.MockedFunction<(args?: unknown) => Promise<unknown[]>>;
    updateMany: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
    update: jest.MockedFunction<(args?: unknown) => Promise<unknown>>;
  };
  $queryRaw: jest.MockedFunction<(query: unknown) => Promise<unknown>>;
};

type PrismaTransactionRunner = (
  fn: (tx: ListingsTransactionMock) => Promise<unknown>,
  options?: unknown,
) => Promise<unknown>;

type PrismaMock = ListingsTransactionMock & {
  $transaction: jest.MockedFunction<PrismaTransactionRunner>;
  applicantProfile: {
    findUnique: jest.MockedFunction<
      (args?: unknown) => Promise<ApplicantProfile | null>
    >;
  };
};

type ListingUpdateArgs = {
  data: {
    coldRent?: number;
    deposit?: number;
    depositMonths?: number;
    title?: string;
  };
};

const makeRawListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: LISTING_ID,
  workspaceId: UNIT_WORKSPACE_ID,
  createdByMembershipId: UNIT_MEMBERSHIP_ID,
  responsibleMembershipId: UNIT_MEMBERSHIP_ID,
  revision: 1,
  assignmentSequence: 1,
  retiredAt: null,
  status: ListingStatus.DRAFT,
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
  title: null,
  shortDescription: null,
  photos: [],
  minimumHouseholdNetIncome: null,
  schufaRequired: false,
  incomeProofRequired: false,
  suitableForPeopleCount: null,
  petsPolicy: null,
  smokingPolicy: null,
  displayOrder: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  publishedAt: null,
  rentedAt: null,
  ...overrides,
});

type ListingUploadFile = NonNullable<Parameters<ListingsService['create']>[2]>;

const makeMulterFile = (): ListingUploadFile => ({
  fieldname: 'file',
  originalname: 'photo.jpg',
  encoding: '7bit',
  mimetype: 'image/jpeg',
  buffer: Buffer.from('fake-image'),
  size: 10,
  stream: null as unknown as import('stream').Readable,
  destination: '',
  filename: '',
  path: '',
});

describe('ListingsService', () => {
  let service: ListingsService;
  let prismaMock: PrismaMock;
  let cloudinaryMock: jest.Mocked<
    Pick<CloudinaryService, 'uploadBuffer' | 'deleteByPublicId'>
  >;
  beforeEach(async () => {
    const transactionRunner: PrismaTransactionRunner = (fn) =>
      Promise.resolve(fn(prismaMock));

    prismaMock = {
      listing: {
        create: jest.fn<(args?: unknown) => Promise<Listing>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        findFirst: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findUnique: jest.fn<(args?: unknown) => Promise<Listing | null>>(),
        update: jest.fn<(args?: unknown) => Promise<Listing>>(),
        count: jest
          .fn<(args?: unknown) => Promise<number>>()
          .mockResolvedValue(0),
        aggregate: jest
          .fn<(args?: unknown) => Promise<unknown>>()
          .mockResolvedValue({ _max: { displayOrder: 0 } }),
      },
      listingImage: {
        create: jest.fn<(args?: unknown) => Promise<ListingImage>>(),
      },
      application: {
        findUnique: jest.fn<(args?: unknown) => Promise<unknown>>(),
        findMany: jest.fn<(args?: unknown) => Promise<unknown[]>>(),
        updateMany: jest.fn<(args?: unknown) => Promise<unknown>>(),
        update: jest.fn<(args?: unknown) => Promise<unknown>>(),
      },
      $queryRaw: jest.fn<(query: unknown) => Promise<unknown>>(),
      $transaction: jest.fn<PrismaTransactionRunner>(transactionRunner),
      applicantProfile: {
        findUnique: jest
          .fn<(args?: unknown) => Promise<ApplicantProfile | null>>()
          .mockResolvedValue(null),
      },
    };

    cloudinaryMock = {
      uploadBuffer:
        jest.fn<
          (buffer: Buffer, folder: string) => Promise<UploadApiResponse>
        >(),
      deleteByPublicId: jest.fn<(publicId: string) => Promise<void>>(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: ListingCriteriaRevisionService,
          useValue: {
            current: jest.fn(),
            changed: jest
              .fn<ListingCriteriaRevisionService['changed']>()
              .mockResolvedValue(null),
          },
        },
        {
          provide: ApplicationEligibilityAssessmentService,
          useValue: { record: jest.fn(), reassessListing: jest.fn() },
        },
        {
          provide: ViewingLifecycleService,
          useValue: {
            closeWithinTransaction: jest.fn(),
            closeListingWithinTransaction: jest.fn(),
            restoreWithinTransaction: jest.fn(),
          },
        },
        {
          provide: ApplicationLifecycleService,
          useValue: { reconcileWaitingWithinTransaction: jest.fn() },
        },
        ListingsService,
        {
          provide: ProviderListingAccess,
          useValue: unitProviderOperations(
            prismaMock,
            async <R>(produce: (tx: typeof prismaMock) => Promise<R>) =>
              (await prismaMock.$transaction(
                produce as unknown as Parameters<
                  typeof prismaMock.$transaction
                >[0],
              )) as R,
          ),
        },
        {
          provide: ApplicationActivityService,
          useValue: { appendWithinTransaction: jest.fn() },
        },
        {
          provide: ListingOrderingService,
          useValue: {
            getNextDisplayOrder: jest.fn(() => Promise.resolve(1)),
            move: jest.fn(),
          },
        },
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: CloudinaryService,
          useValue: cloudinaryMock,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => CLOUDINARY_FOLDER) },
        },
        ListingInputRules,
        ListingResponseMapper,
      ],
    }).compile();

    service = module.get<ListingsService>(ListingsService);
  });

  describe('create', () => {
    it.each([false, true])(
      'fails closed before quota integration, including uploaded input: %s',
      async (withFile) => {
        await expect(
          service.create(
            unitProvider(PROVIDER_ID),
            { city: 'Berlin' },
            withFile ? makeMulterFile() : undefined,
          ),
        ).rejects.toThrow(
          'Listing creation requires entitlement/quota integration',
        );
        expect(prismaMock.listing.create).not.toHaveBeenCalled();
        expect(cloudinaryMock.uploadBuffer).not.toHaveBeenCalled();
      },
    );
  });
  describe('update', () => {
    function isolatedTransaction(row: Listing) {
      const tx = {
        ...prismaMock,
        $queryRaw: jest
          .fn<(query: unknown) => Promise<unknown>>()
          .mockResolvedValue([]),
        listing: {
          ...prismaMock.listing,
          findFirst: jest
            .fn<(args?: unknown) => Promise<Listing | null>>()
            .mockResolvedValue(row),
          update: jest
            .fn<(args?: unknown) => Promise<Listing>>()
            .mockResolvedValue(row),
        },
      };
      prismaMock.listing.findFirst.mockRejectedValue(
        new Error('Root pre-read is forbidden'),
      );
      prismaMock.listing.update.mockRejectedValue(
        new Error('Root write is forbidden'),
      );
      prismaMock.$transaction.mockImplementation((fn) => fn(tx));
      return tx;
    }

    it('locks before a fresh transaction-client read and writes only that transaction', async () => {
      const tx = isolatedTransaction(
        makeRawListing({ coldRent: 1200, depositMonths: 3 }),
      );
      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        coldRent: 1300,
      });
      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
      );
      expect(tx.listing.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        tx.listing.update.mock.invocationCallOrder[0],
      );
      expect(tx.listing.findFirst).toHaveBeenCalledWith({
        where: { id: LISTING_ID, workspaceId: UNIT_WORKSPACE_ID },
      });
      expect(tx.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { coldRent: 1300, depositMonths: 3, deposit: 3900 },
      });
      expect(prismaMock.listing.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it.each([
      [{ depositMonths: 3 }, { depositMonths: 3, deposit: 3600 }],
      [
        { coldRent: 1300, depositMonths: 1 },
        { coldRent: 1300, depositMonths: 1, deposit: 1300 },
      ],
      [{ title: 'New title' }, { title: 'New title' }],
      [
        { coldRent: 1234.56, title: 'New title' },
        {
          coldRent: 1234.56,
          depositMonths: 2,
          deposit: 2469.12,
          title: 'New title',
        },
      ],
      [
        { coldRent: null, depositMonths: null, title: 'Nulls retained' },
        { depositMonths: 2, deposit: 2400, title: 'Nulls retained' },
      ],
    ])(
      'preserves current partial-update and rounding semantics for %j',
      async (patch, expected) => {
        const tx = isolatedTransaction(
          makeRawListing({ coldRent: 1200, depositMonths: 2 }),
        );
        await service.update(
          LISTING_ID,
          unitProvider(PROVIDER_ID),
          patch as Parameters<ListingsService['update']>[2],
        );
        expect(tx.listing.update).toHaveBeenCalledWith({
          where: { id: LISTING_ID },
          data: expected,
        });
      },
    );

    it('re-reads listing state inside the workspace mutation transaction', async () => {
      const tx = isolatedTransaction(
        makeRawListing({ coldRent: 1000, depositMonths: 2 }),
      );
      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        coldRent: 1200,
      });
      expect(tx.listing.findFirst).toHaveBeenCalledTimes(1);
      expect(tx.listing.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID },
        data: { coldRent: 1200, depositMonths: 2, deposit: 2400 },
      });
    });

    it('validates against the locked row and performs no write on failure', async () => {
      const tx = isolatedTransaction(
        makeRawListing({ coldRent: 1200, depositMonths: 3 }),
      );
      await expect(
        service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
          deposit: 2400,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(tx.listing.update).not.toHaveBeenCalled();
    });

    it('recalculates deposit when cold rent changes', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      const updated = makeRawListing({
        coldRent: 1300,
        deposit: 2600,
        depositMonths: 2,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      const result = await service.update(
        LISTING_ID,
        unitProvider(PROVIDER_ID),
        {
          coldRent: 1300,
        },
      );

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          coldRent: 1300,
          deposit: 2600,
          depositMonths: 2,
        }),
      );
      expect(result).toEqual(updated);
    });

    it('recalculates deposit when deposit months change', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      const updated = makeRawListing({
        coldRent: 1000,
        deposit: 3000,
        depositMonths: 3,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        depositMonths: 3,
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          deposit: 3000,
          depositMonths: 3,
        }),
      );
    });

    it('stores deposit months without requiring cold rent on a draft', async () => {
      const listing = makeRawListing({ coldRent: null, depositMonths: 2 });
      const updated = makeRawListing({ coldRent: null, depositMonths: 1 });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(updated);

      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        depositMonths: 1,
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual({ depositMonths: 1 });
    });

    it('keeps existing eligibility criteria when they are omitted', async () => {
      const listing = makeRawListing({
        minimumHouseholdNetIncome: 3000,
        suitableForPeopleCount: 2,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(
        makeRawListing({
          minimumHouseholdNetIncome: 3000,
          suitableForPeopleCount: 2,
          title: 'Updated title',
        }),
      );

      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        title: 'Updated title',
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;

      expect(listingUpdateArgs.data).toEqual({ title: 'Updated title' });
    });

    it('clears explicitly unselected eligibility criteria', async () => {
      const listing = makeRawListing({
        minimumHouseholdNetIncome: 3000,
        schufaRequired: true,
        incomeProofRequired: true,
        suitableForPeopleCount: 2,
        petsPolicy: PetsPolicy.ALLOWED,
        smokingPolicy: SmokingPolicy.ALLOWED,
      });
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue(
        makeRawListing({
          minimumHouseholdNetIncome: null,
          schufaRequired: false,
          incomeProofRequired: false,
          suitableForPeopleCount: null,
          petsPolicy: null,
          smokingPolicy: null,
        }),
      );

      await service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
        minimumHouseholdNetIncome: null,
        schufaRequired: false,
        incomeProofRequired: false,
        suitableForPeopleCount: null,
        petsPolicy: null,
        smokingPolicy: null,
      });

      const listingUpdateArgs = prismaMock.listing.update.mock
        .calls[0][0] as ListingUpdateArgs;
      expect(listingUpdateArgs.data).toEqual(
        expect.objectContaining({
          minimumHouseholdNetIncome: null,
          schufaRequired: false,
          incomeProofRequired: false,
          suitableForPeopleCount: null,
          petsPolicy: null,
          smokingPolicy: null,
        }),
      );
    });

    it('rejects mismatched deposit on update', async () => {
      const listing = makeRawListing({ coldRent: 1000, depositMonths: 2 });
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
          deposit: 3000,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it('rejects bedrooms greater than rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);

      await expect(
        service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
          rooms: 2,
          bedrooms: 5,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prismaMock.listing.update).not.toHaveBeenCalled();
    });

    it('allows bedrooms equal to rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue({
        ...listing,
        rooms: 3,
        bedrooms: 3,
      });

      await expect(
        service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
          rooms: 3,
          bedrooms: 3,
        }),
      ).resolves.toBeDefined();
      expect(prismaMock.listing.update).toHaveBeenCalled();
    });

    it('allows bedrooms less than rooms on update', async () => {
      const listing = makeRawListing();
      prismaMock.listing.findFirst.mockResolvedValue(listing);
      prismaMock.listing.update.mockResolvedValue({
        ...listing,
        rooms: 4,
        bedrooms: 2,
      });

      await expect(
        service.update(LISTING_ID, unitProvider(PROVIDER_ID), {
          rooms: 4,
          bedrooms: 2,
        }),
      ).resolves.toBeDefined();
    });
  });
});
