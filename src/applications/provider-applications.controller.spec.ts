import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Application } from '../generated/prisma/client';
import { ApplicationStatus, Role, UserStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';
import { ProviderApplicationsController } from './provider-applications.controller';
import { WaitingCountResponseDto } from './dto/waiting-count-response.dto';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { PromotionResponseDto } from './dto/promotion-response.dto';

const PROVIDER_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000003';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000004';

type RouteArgMetadata = {
  index: number;
  data?: unknown;
  pipes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRouteArgMetadata(value: unknown): value is RouteArgMetadata {
  return isRecord(value) && typeof value.index === 'number';
}

function firstPipe(metadata: RouteArgMetadata | undefined): unknown {
  return Array.isArray(metadata?.pipes) ? metadata.pipes[0] : undefined;
}

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

const makeApplication = (): Application => ({
  id: APPLICATION_ID,
  listingId: LISTING_ID,
  applicantId: APPLICANT_ID,
  status: ApplicationStatus.ACTIVE,
  queueOrder: BigInt(1),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const getRouteArgMetadata = (
  methodName: string,
  parameterIndex: number,
): RouteArgMetadata | undefined => {
  const metadata: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    ProviderApplicationsController,
    methodName,
  );

  if (!isRecord(metadata)) {
    return undefined;
  }

  return Object.values(metadata)
    .filter(isRouteArgMetadata)
    .find((routeArgMetadata) => routeArgMetadata.index === parameterIndex);
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
            findActiveByListing: jest.fn(),
            findWaitingCountByListing: jest.fn(),
            promoteWaitingApplications: jest.fn(),
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

      const result = await controller.findAll(makeProviderUser());

      expect(applicationsService.findAllByProvider).toHaveBeenCalledWith(
        PROVIDER_ID,
      );
      expect(result).toEqual(
        applications.map(
          (application) => new ApplicationResponseDto(application),
        ),
      );
    });
  });

  describe('findByListing', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('findByListing', 0);

      expect(metadata?.data).toBe('id');
      expect(firstPipe(metadata)).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls applicationsService.findAllByListing with listing id and provider id', async () => {
      const applications = [makeApplication()];
      applicationsService.findAllByListing.mockResolvedValue(applications);

      const result = await controller.findByListing(
        LISTING_ID,
        makeProviderUser(),
      );

      expect(applicationsService.findAllByListing).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(result).toEqual(
        applications.map(
          (application) => new ApplicationResponseDto(application),
        ),
      );
    });
  });

  describe('findActiveByListing', () => {
    it('calls applicationsService.findActiveByListing with listing id and provider id', async () => {
      const applications = [makeApplication()];
      applicationsService.findActiveByListing.mockResolvedValue(applications);

      const result = await controller.findActiveByListing(
        LISTING_ID,
        makeProviderUser(),
      );

      expect(applicationsService.findActiveByListing).toHaveBeenCalledWith(
        LISTING_ID,
        PROVIDER_ID,
      );
      expect(result).toEqual(
        applications.map(
          (application) => new ApplicationResponseDto(application),
        ),
      );
    });
  });

  describe('findWaitingCount', () => {
    it('returns the waiting count for an owned listing', async () => {
      applicationsService.findWaitingCountByListing.mockResolvedValue(4);

      await expect(
        controller.findWaitingCount(LISTING_ID, makeProviderUser()),
      ).resolves.toEqual(new WaitingCountResponseDto(4));
      expect(
        applicationsService.findWaitingCountByListing,
      ).toHaveBeenCalledWith(LISTING_ID, PROVIDER_ID);
    });
  });

  describe('promoteWaiting', () => {
    it('promotes waiting applications for the provider-owned listing', async () => {
      applicationsService.promoteWaitingApplications.mockResolvedValue(2);

      await expect(
        controller.promoteWaiting(LISTING_ID, makeProviderUser()),
      ).resolves.toEqual(new PromotionResponseDto(2));
      expect(
        applicationsService.promoteWaitingApplications,
      ).toHaveBeenCalledWith(LISTING_ID, PROVIDER_ID);
    });
  });
});
