import type { Role, UserStatus } from '../../generated/prisma/enums';

export type SafeUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  status: UserStatus;
  acceptedTermsAt: Date;
  acceptedPrivacyAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
