import type {
  ApplicationAdmission,
  ApplicationSubmissionBlockReason,
} from '../application-admission.service';
import type { ApplicationStatus } from '../../generated/prisma/enums';

export class ApplicationAdmissionResponseDto implements ApplicationAdmission {
  readonly hasApplicationHistory: boolean;
  readonly currentApplicationId: string | null;
  readonly currentApplicationStatus: ApplicationStatus | null;
  readonly canSubmitApplication: boolean;
  readonly submissionBlockReason: ApplicationSubmissionBlockReason | null;
  readonly reapplyAvailableAt: Date | null;

  constructor(admission?: ApplicationAdmission) {
    this.hasApplicationHistory = admission?.hasApplicationHistory ?? false;
    this.currentApplicationId = admission?.currentApplicationId ?? null;
    this.currentApplicationStatus = admission?.currentApplicationStatus ?? null;
    this.canSubmitApplication = admission?.canSubmitApplication ?? false;
    this.submissionBlockReason = admission
      ? admission.submissionBlockReason
      : 'AUTHENTICATION_REQUIRED';
    this.reapplyAvailableAt = admission?.reapplyAvailableAt ?? null;
  }
}
