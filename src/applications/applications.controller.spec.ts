import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Application } from '../generated/prisma/client';
import { Role, UserStatus, ApplicationStatus } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

const APPLICANT_ID = '00000000-0000-4000-8000-000000000001';
const LISTING_ID = '00000000-0000-4000-8000-000000000002';
const APPLICATION_ID = '00000000-0000-4000-8000-000000000003';

type RouteArgMetadata = {
  index: number;
  data?: string;
  pipes?: readonly unknown[];
};

const makeApplicantUser = (): SafeUser => ({
  id: APPLICANT_ID,
  name: 'Applicant User',
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
});

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
    ApplicationsController,
    methodName,
  ) as Record<string, RouteArgMetadata> | undefined;

  return Object.values(metadata ?? {}).find(
    (routeArgMetadata) => routeArgMetadata.index === parameterIndex,
  );
};

describe('ApplicationsController', () => {
  let controller: ApplicationsController;
  let applicationsService: jest.Mocked<ApplicationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicationsController],
      providers: [
        {
          provide: ApplicationsService,
          useValue: {
            apply: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ApplicationsController>(ApplicationsController);
    applicationsService = module.get(ApplicationsService);
  });

  describe('apply', () => {
    it('validates id as a UUID v4 route parameter', () => {
      const metadata = getRouteArgMetadata('apply', 0);

      expect(metadata?.data).toBe('id');
      expect(metadata?.pipes?.[0]).toBeInstanceOf(ParseUUIDPipe);
    });

    it('calls applicationsService.apply with listing id and applicant id', async () => {
      const application = makeApplication();
      applicationsService.apply.mockResolvedValue(application);

      const result = await controller.apply(LISTING_ID, makeApplicantUser());

      expect(applicationsService.apply).toHaveBeenCalledWith(
        LISTING_ID,
        APPLICANT_ID,
      );
      expect(result).toEqual(application);
    });
  });
});
