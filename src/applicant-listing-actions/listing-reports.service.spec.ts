import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { ListingReport } from '../generated/prisma/client';
import { ListingReportReason, ListingStatus } from '../generated/prisma/enums';
import { PublishedListingsService } from '../published-listings/published-listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListingReportsService } from './listing-reports.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const REPORT_ID = '00000000-0000-4000-8000-000000000003';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

const makeReport = (overrides: Partial<ListingReport> = {}): ListingReport => ({
  id: REPORT_ID,
  reporterApplicantId: APPLICANT_ID,
  listingId: LISTING_ID,
  reason: ListingReportReason.MISLEADING_INFO,
  detail: null,
  createdAt: CREATED_AT,
  ...overrides,
});

type PrismaMock = {
  listingReport: {
    create: jest.MockedFunction<(args?: unknown) => Promise<ListingReport>>;
  };
};

describe('ListingReportsService', () => {
  let service: ListingReportsService;
  let prismaMock: PrismaMock;
  let publishedListingsService: jest.Mocked<
    Pick<PublishedListingsService, 'findPublishedListingOrThrow'>
  >;

  beforeEach(async () => {
    prismaMock = {
      listingReport: {
        create: jest.fn<(args?: unknown) => Promise<ListingReport>>(),
      },
    };

    publishedListingsService = {
      findPublishedListingOrThrow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListingReportsService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: PublishedListingsService,
          useValue: publishedListingsService,
        },
      ],
    }).compile();

    service = module.get(ListingReportsService);
  });

  it('creates a report for a published listing', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });
    const report = makeReport();
    prismaMock.listingReport.create.mockResolvedValue(report);

    const result = await service.report(APPLICANT_ID, LISTING_ID, {
      reason: ListingReportReason.MISLEADING_INFO,
    });

    expect(
      publishedListingsService.findPublishedListingOrThrow,
    ).toHaveBeenCalledWith(LISTING_ID);
    expect(prismaMock.listingReport.create).toHaveBeenCalledWith({
      data: {
        reporterApplicantId: APPLICANT_ID,
        listingId: LISTING_ID,
        reason: ListingReportReason.MISLEADING_INFO,
        detail: null,
      },
    });
    expect(result).toEqual(report);
  });

  it('trims detail and stores null for blank detail', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });
    prismaMock.listingReport.create.mockResolvedValue(
      makeReport({ detail: 'Details here' }),
    );

    await service.report(APPLICANT_ID, LISTING_ID, {
      reason: ListingReportReason.SCAM_OR_FRAUD,
      detail: '  Details here  ',
    });

    expect(prismaMock.listingReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detail: 'Details here',
      }),
    });
  });

  it('rejects OTHER without detail', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });

    await expect(
      service.report(APPLICANT_ID, LISTING_ID, {
        reason: ListingReportReason.OTHER,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prismaMock.listingReport.create).not.toHaveBeenCalled();
  });

  it('requires detail for OTHER', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });
    prismaMock.listingReport.create.mockResolvedValue(
      makeReport({
        reason: ListingReportReason.OTHER,
        detail: 'More context',
      }),
    );

    await service.report(APPLICANT_ID, LISTING_ID, {
      reason: ListingReportReason.OTHER,
      detail: 'More context',
    });

    expect(prismaMock.listingReport.create).toHaveBeenCalled();
  });

  it('rejects detail longer than 500 characters', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });

    await expect(
      service.report(APPLICANT_ID, LISTING_ID, {
        reason: ListingReportReason.OTHER,
        detail: 'a'.repeat(501),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when the listing is not published', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockRejectedValue(
      new NotFoundException('Listing not found'),
    );

    await expect(
      service.report(APPLICANT_ID, LISTING_ID, {
        reason: ListingReportReason.DUPLICATE_OR_SPAM,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException on duplicate report', async () => {
    publishedListingsService.findPublishedListingOrThrow.mockResolvedValue({
      id: LISTING_ID,
      status: ListingStatus.PUBLISHED,
      publishedAt: CREATED_AT,
    });
    prismaMock.listingReport.create.mockRejectedValue(
      new PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.report(APPLICANT_ID, LISTING_ID, {
        reason: ListingReportReason.INAPPROPRIATE_CONTENT,
      }),
    ).rejects.toThrow(ConflictException);
  });
});
