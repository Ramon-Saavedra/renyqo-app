import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ApplicationStatus, Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantApplicationsController } from './applicant-applications.controller';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';
import { ApplicationsService } from './applications.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';

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

const application: ApplicantApplicationRecord = {
  id: '00000000-0000-4000-8000-000000000003',
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.ACTIVE,
  rejectedAt: null,
  publicReason: null,
  activeAt: new Date('2024-01-01'),
  withdrawnAt: null,
  queueOrder: BigInt(1),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-02'),
  listing: {
    id: LISTING_ID,
    title: 'Apartment',
    city: 'Berlin',
    coldRent: 1000,
    images: [
      {
        secureUrl: 'https://example.com/image.jpg',
        isCover: true,
        position: 0,
      },
    ],
  },
};

describe('ApplicantApplicationsController', () => {
  let controller: ApplicantApplicationsController;
  let applicationsService: jest.Mocked<ApplicationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantApplicationsController],
      providers: [
        {
          provide: ApplicationsService,
          useValue: { findAllByApplicantWithListing: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ApplicantApplicationsController);
    applicationsService = module.get(ApplicationsService);
  });

  it('returns the safe applicant application summary', async () => {
    applicationsService.findAllByApplicantWithListing.mockResolvedValue([
      application,
    ]);

    const [result] = await controller.findAll(user);

    expect(result.id).toBe(application.id);
    expect(result.listingId).toBe(LISTING_ID);
    expect(result.status).toBe(ApplicationStatus.ACTIVE);
    expect(result.listing).toEqual({
      title: 'Apartment',
      city: 'Berlin',
      coldRent: 1000,
      imageUrl: 'https://example.com/image.jpg',
    });
  });
});
