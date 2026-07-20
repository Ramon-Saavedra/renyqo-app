import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { describe, expect, it } from '@jest/globals';

import { AuthenticatedGuard } from '../../auth/guards/authenticated.guard';
import { Role, UserStatus } from '../../generated/prisma/enums';
import type { SafeUser } from '../../users/types/safe-user.type';
import { ApplicantOnlyGuard } from './applicant-only.guard';
import { ProviderOnlyGuard } from './provider-only.guard';

const makeUser = (
  role: Role,
  status: UserStatus = UserStatus.ACTIVE,
): SafeUser => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test User',
  email: 'test@example.com',
  role,
  providerType: role === Role.PROVIDER ? 'private' : null,
  companyName: null,
  emailVerified: false,
  status,
  acceptedTermsAt: new Date('2024-01-01'),
  acceptedPrivacyAt: new Date('2024-01-01'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
});

const makeContext = (
  user: unknown,
  authenticated = true,
): ExecutionContextHost =>
  new ExecutionContextHost([
    {
      user,
      isAuthenticated: () => authenticated,
    },
  ]);

describe('authentication and role guards', () => {
  it('accepts only active authenticated users', () => {
    const guard = new AuthenticatedGuard();

    expect(guard.canActivate(makeContext(makeUser(Role.APPLICANT)))).toBe(true);
    expect(
      guard.canActivate(
        makeContext(makeUser(Role.APPLICANT, UserStatus.SUSPENDED)),
      ),
    ).toBe(false);
    expect(
      guard.canActivate(makeContext(makeUser(Role.APPLICANT), false)),
    ).toBe(false);
  });

  it('accepts only active applicants', () => {
    const guard = new ApplicantOnlyGuard();

    expect(guard.canActivate(makeContext(makeUser(Role.APPLICANT)))).toBe(true);
    expect(guard.canActivate(makeContext(makeUser(Role.PROVIDER)))).toBe(false);
    expect(
      guard.canActivate(
        makeContext(makeUser(Role.APPLICANT, UserStatus.DELETED)),
      ),
    ).toBe(false);
    expect(guard.canActivate(makeContext({ role: Role.APPLICANT }))).toBe(
      false,
    );
  });

  it('accepts only active providers', () => {
    const guard = new ProviderOnlyGuard();

    expect(guard.canActivate(makeContext(makeUser(Role.PROVIDER)))).toBe(true);
    expect(guard.canActivate(makeContext(makeUser(Role.APPLICANT)))).toBe(
      false,
    );
    expect(
      guard.canActivate(
        makeContext(makeUser(Role.PROVIDER, UserStatus.SUSPENDED)),
      ),
    ).toBe(false);
  });
});
