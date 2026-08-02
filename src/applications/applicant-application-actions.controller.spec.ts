import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Application } from '../generated/prisma/client';
import { ApplicationStatus, Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantApplicationActionsController } from './applicant-application-actions.controller';
import { ApplicationsService } from './applications.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000002';
const LISTING_ID = '00000000-0000-4000-8000-000000000003';

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

const application: Application = {
  id: APPLICATION_ID,
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.WITHDRAWN,
  rejectedAt: null,
  publicReason: null,
  queueOrder: BigInt(1),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-02'),
};

describe('ApplicantApplicationActionsController', () => {
  let controller: ApplicantApplicationActionsController;
  let applicationsService: jest.Mocked<ApplicationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantApplicationActionsController],
      providers: [
        {
          provide: ApplicationsService,
          useValue: { withdraw: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(ApplicantApplicationActionsController);
    applicationsService = module.get(ApplicationsService);
  });

  it('withdraws an application for the authenticated applicant', async () => {
    applicationsService.withdraw.mockResolvedValue(application);

    const result = await controller.withdraw(APPLICATION_ID, user);

    expect(applicationsService.withdraw).toHaveBeenCalledWith(
      APPLICATION_ID,
      APPLICANT_ID,
    );
    expect(result).toEqual({
      id: APPLICATION_ID,
      listingId: LISTING_ID,
      status: ApplicationStatus.WITHDRAWN,
      rejectedAt: null,
      publicReason: null,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    });
  });
});
