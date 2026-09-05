import { ApplicationStatus } from '../generated/prisma/enums';

export const BLOCKING_APPLICATION_STATUSES = [
  ApplicationStatus.ACTIVE,
  ApplicationStatus.WAITING,
  ApplicationStatus.REJECTED,
  ApplicationStatus.ACCEPTED,
] as const;
