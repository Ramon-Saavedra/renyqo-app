import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { ListingReport } from '../generated/prisma/client';
import {
  ListingReportReason,
  Role,
  UserStatus,
} from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantListingActionsController } from './applicant-listing-actions.controller';
import { ListingReportThrottlerGuard } from './guards/listing-report-throttler.guard';
import { ListingReportsService } from './listing-reports.service';
import { SavedListingsService } from '../saved-listings/saved-listings.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const REPORT_ID = '00000000-0000-4000-8000-000000000003';
const SAVED_AT = new Date('2026-01-01T00:00:00.000Z');

const user: SafeUser = {
  id: APPLICANT_ID,
  name: 'Applicant',
  email: 'applicant@example.com',
  role: Role.APPLICANT,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const report: ListingReport = {
  id: REPORT_ID,
  reporterApplicantId: APPLICANT_ID,
  listingId: LISTING_ID,
  reason: ListingReportReason.MISLEADING_INFO,
  detail: null,
  createdAt: SAVED_AT,
};

describe('ApplicantListingActionsController', () => {
  let controller: ApplicantListingActionsController;
  let savedListingsService: jest.Mocked<SavedListingsService>;
  let listingReportsService: jest.Mocked<ListingReportsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantListingActionsController],
      providers: [
        {
          provide: SavedListingsService,
          useValue: {
            save: jest.fn(),
            unsave: jest.fn(),
          },
        },
        {
          provide: ListingReportsService,
          useValue: {
            report: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(ListingReportThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ApplicantListingActionsController);
    savedListingsService = module.get(SavedListingsService);
    listingReportsService = module.get(ListingReportsService);
  });

  it('saves a listing for the authenticated applicant', async () => {
    savedListingsService.save.mockResolvedValue({
      saved: true,
      savedAt: SAVED_AT,
    });

    const result = await controller.save(LISTING_ID, user);

    expect(savedListingsService.save).toHaveBeenCalledWith(
      APPLICANT_ID,
      LISTING_ID,
    );
    expect(result).toEqual({ saved: true, savedAt: SAVED_AT });
  });

  it('unsaves a listing for the authenticated applicant', async () => {
    savedListingsService.unsave.mockResolvedValue({
      saved: false,
      savedAt: null,
    });

    const result = await controller.unsave(LISTING_ID, user);

    expect(savedListingsService.unsave).toHaveBeenCalledWith(
      APPLICANT_ID,
      LISTING_ID,
    );
    expect(result).toEqual({ saved: false, savedAt: null });
  });

  it('reports a listing for the authenticated applicant', async () => {
    listingReportsService.report.mockResolvedValue(report);

    const result = await controller.report(
      LISTING_ID,
      { reason: ListingReportReason.MISLEADING_INFO },
      user,
    );

    expect(listingReportsService.report).toHaveBeenCalledWith(
      APPLICANT_ID,
      LISTING_ID,
      { reason: ListingReportReason.MISLEADING_INFO },
    );
    expect(result).toEqual({
      id: REPORT_ID,
      listingId: LISTING_ID,
      reason: ListingReportReason.MISLEADING_INFO,
      createdAt: SAVED_AT,
    });
    expect(result).not.toHaveProperty('reporterApplicantId');
  });
});
