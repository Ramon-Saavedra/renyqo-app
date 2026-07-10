import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';

import { Role, UserStatus } from '../../generated/prisma/enums';
import type { SafeUser } from '../../users/types/safe-user.type';
import { CurrentUser } from './current-user.decorator';

const USER_ID = '00000000-0000-4000-8000-000000000001';

type CustomRouteArgMetadata = {
  index: number;
  factory: (data: unknown, ctx: ExecutionContext) => SafeUser;
};

const makeSafeUser = (): SafeUser => ({
  id: USER_ID,
  name: 'Test User',
  email: 'test@example.com',
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

const makeExecutionContext = (user: SafeUser): ExecutionContext =>
  ({
    switchToHttp: jest.fn(() => ({
      getRequest: jest.fn(() => ({ user })),
    })),
  }) as unknown as ExecutionContext;

class TestController {
  getCurrentUser(@CurrentUser() user: SafeUser): SafeUser {
    return user;
  }
}

describe('CurrentUser', () => {
  it('returns the authenticated request user from the execution context', () => {
    const user = makeSafeUser();
    const metadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      TestController,
      'getCurrentUser',
    ) as Record<string, CustomRouteArgMetadata>;
    const routeArgMetadata = Object.values(metadata).find(
      (value) => value.index === 0,
    );

    const result = routeArgMetadata?.factory(
      undefined,
      makeExecutionContext(user),
    );

    expect(result).toBe(user);
  });
});
