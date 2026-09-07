import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Response } from 'express';

import { ApplicantSavedListingsController } from './applicant-saved-listings.controller';
import { ApplicantListingsPageDto } from '../listings/dto/applicant-listings-page.dto';
import { SavedListingsService } from '../saved-listings/saved-listings.service';
import { Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';

const applicantUser: SafeUser = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Test',
  email: 'test@test.com',
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

describe('ApplicantSavedListingsController', () => {
  let controller: ApplicantSavedListingsController;
  let savedListingsService: jest.Mocked<
    Pick<SavedListingsService, 'findSavedListingsPage'>
  >;

  beforeEach(async () => {
    savedListingsService = {
      findSavedListingsPage: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicantSavedListingsController],
      providers: [
        {
          provide: SavedListingsService,
          useValue: savedListingsService,
        },
      ],
    }).compile();

    controller = module.get(ApplicantSavedListingsController);
  });

  it('delegates to SavedListingsService.findSavedListingsPage', async () => {
    const page = new ApplicantListingsPageDto([], null, 0);
    savedListingsService.findSavedListingsPage.mockResolvedValue(page);
    const res = {
      setHeader: jest.fn(),
    } as unknown as Response;

    const result = await controller.findAll(applicantUser, {}, res);

    expect(savedListingsService.findSavedListingsPage).toHaveBeenCalledWith(
      applicantUser,
      {},
      res,
    );
    expect(result).toBe(page);
  });
});
