import type { Role, UserStatus } from '../../generated/prisma/enums';

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
