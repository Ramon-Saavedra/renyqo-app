import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request } from 'express';

import type { Application } from '../generated/prisma/client';
import { ApplicationStatus, Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';
import { ProviderApplicationsController } from './provider-applications.controller';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000003';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000004';

type RouteArgMetadata = {
  index: number;
  data?: string;
  pipes?: readonly unknown[];
};

const makeProviderUser = (): SafeUser => ({
  id: PROVIDER_ID,
  name: 'Provider User',
  email: 'provider@example.com',
  role: Role.PROVIDER,
  providerType: null,
  companyName: null,
  emailVerified: false,
  status: UserStatus.ACTIVE,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const makeReq = (): Request =>
  ({ user: makeProviderUser() }) as unknown as Request;

const makeApplication = (): Application => ({
  id: APPLICATION_ID,
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.ACTIVE,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const getRouteArgMetadata = (
  methodName: string,
  parameterIndex: number,
): RouteArgMetadata | undefined => {
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ProviderApplicationsController,
    methodName,
  ) as Record<string, RouteArgMetadata> | undefined;

  return Object.values(metadata ?? {}).find(
    (routeArgMetadata) => routeArgMetadata.index === parameterIndex,
  );
};

describe('ProviderApplicationsController', () => {
  let controller: ProviderApplicationsController;
  let applicationsService: jest.Mocked<ApplicationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProviderApplicationsController],
      providers: [
        {
          provide: ApplicationsService,
          useValue: {
            findAllByProvider: jest.fn(),
            findAllByListing: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ProviderApplicationsController>(
      ProviderApplicationsController,
    );
    applicationsService = module.get(ApplicationsService);
  });

  describe('findAll', () => {
    it('calls applicationsService.findAllByProvider with provider id', async () => {
      const applications = [makeApplication()];
      applicationsService.findAllByProvider.mockResolvedValue(applications);

      const result = await controller.findAll(makeReq());

      expect(applicationsService.findAllByProvider).toHaveBeenCalledWith(
        PROVIDER_ID,
      );
      expect(result).toEqual(applications);
    });
  });

  describe('findByListing', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('findByListing', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls applicationsService.findAllByListing with listing id and provider id', async () => {
      const applications = [makeApplication()];
      applicationsService.findAllByListing.mockResolvedValue(applications);

      const result = await controller.findByListing(LISTING_ID, makeReq());

      expect(applicationsService.findAllByListing).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(result).toEqual(applications);
    });
  });
});
