import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Role, UserStatus } from '../generated/prisma/enums';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { EligibilityResponseDto } from './dto/eligibility-response.dto';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';

const LISTING_ID = '00000000-0000-4000-8000-000000000001';
const APPLICANT_ID = '00000000-0000-4000-8000-000000000002';

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

const getRouteArgMetadata = (
  methodName: string,
  parameterIndex: number,
): RouteArgMetadata | undefined => {
  const metadata: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    EligibilityController,
    methodName,
  );

  if (!isRecord(metadata)) {
    return undefined;
  }

  return Object.values(metadata)
    .filter(isRouteArgMetadata)
    .find((routeArgMetadata) => routeArgMetadata.index === parameterIndex);
};

describe('EligibilityController', () => {
  let controller: EligibilityController;
  let eligibilityService: jest.Mocked<EligibilityService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EligibilityController],
      providers: [
        {
          provide: EligibilityService,
          useValue: { check: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<EligibilityController>(EligibilityController);
    eligibilityService = module.get(EligibilityService);
  });

  it('exposes eligibility as a read-only GET route', () => {
    const method: unknown = Reflect.getMetadata(
      METHOD_METADATA,
      EligibilityController.prototype.check,
    );
    const path: unknown = Reflect.getMetadata(
      PATH_METADATA,
      EligibilityController.prototype.check,
    );

    expect(method).toBe(RequestMethod.GET);
    expect(path).toBe(':id/eligibility');
  });

  it('validates the listing id as a UUID v4 route parameter', () => {
    const metadata = getRouteArgMetadata('check', 0);

    expect(metadata?.data).toBe('id');
    expect(firstPipe(metadata)).toBeInstanceOf(ParseUUIDPipe);
  });

  it('requires an authenticated applicant', () => {
    const guards: unknown = Reflect.getMetadata(
      GUARDS_METADATA,
      EligibilityController,
    );

    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toEqual(
      expect.arrayContaining([AuthenticatedGuard, ApplicantOnlyGuard]),
    );
  });

  it('delegates the eligibility check to the service', async () => {
    const response = new EligibilityResponseDto(
      true,
      [],
      [],
      new Date('2024-01-01'),
    );
    eligibilityService.check.mockResolvedValue(response);

    await expect(
      controller.check(LISTING_ID, makeApplicantUser()),
    ).resolves.toBe(response);
    expect(eligibilityService.check).toHaveBeenCalledWith(
      LISTING_ID,
      APPLICANT_ID,
    );
  });
});
