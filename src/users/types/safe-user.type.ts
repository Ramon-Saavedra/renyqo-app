import type { Role, UserStatus } from '../../generated/prisma/enums';
import {
  Role as RoleValues,
  UserStatus as UserStatusValues,
} from '../../generated/prisma/enums';

export type SafeProviderType = 'private' | 'company';

export type SafeUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  providerType: SafeProviderType | null;
  companyName: string | null;
  emailVerified: boolean;
  status: UserStatus;
  acceptedTermsAt: Date;
  acceptedPrivacyAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSafeUser(value: unknown): value is SafeUser {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    (value.role === RoleValues.APPLICANT ||
      value.role === RoleValues.PROVIDER ||
      value.role === RoleValues.ADMIN) &&
    (value.providerType === null ||
      value.providerType === 'private' ||
      value.providerType === 'company') &&
    (value.companyName === null || typeof value.companyName === 'string') &&
    typeof value.emailVerified === 'boolean' &&
    (value.status === UserStatusValues.ACTIVE ||
      value.status === UserStatusValues.SUSPENDED ||
      value.status === UserStatusValues.DELETED) &&
    value.acceptedTermsAt instanceof Date &&
    value.acceptedPrivacyAt instanceof Date &&
    value.createdAt instanceof Date &&
    value.updatedAt instanceof Date
  );
}

export function sanitizeSafeUser(user: SafeUser): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    providerType: user.providerType,
    companyName: user.companyName,
    emailVerified: user.emailVerified,
    status: user.status,
    acceptedTermsAt: user.acceptedTermsAt,
    acceptedPrivacyAt: user.acceptedPrivacyAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
