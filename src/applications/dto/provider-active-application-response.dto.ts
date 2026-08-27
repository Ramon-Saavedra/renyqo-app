import type {
  ApplicantProfile,
  Application,
  User,
} from '../../generated/prisma/client';
import type { EligibilityWarning } from '../../eligibility/dto/eligibility-response.dto';

export type ProviderActiveApplicationRecord = Pick<
  Application,
  'id' | 'listingId' | 'status'
> & {
  applicant: Pick<User, 'name'> & {
    profile: Pick<ApplicantProfile, 'peopleCount'> | null;
  };
  warnings: EligibilityWarning[];
};

export class ProviderActiveApplicantSummaryDto {
  readonly name: string;
  readonly peopleCount: number | null;
  readonly warnings: EligibilityWarning[];

  constructor(
    applicant: Pick<User, 'name'>,
    profile: Pick<ApplicantProfile, 'peopleCount'> | null,
    warnings: EligibilityWarning[],
  ) {
    this.name = applicant.name;
    this.peopleCount = profile?.peopleCount ?? null;
    this.warnings = warnings;
  }
}

export class ProviderActiveApplicationResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly status: Application['status'];
  readonly applicant: ProviderActiveApplicantSummaryDto;

  constructor(application: ProviderActiveApplicationRecord) {
    this.id = application.id;
    this.listingId = application.listingId;
    this.status = application.status;
    this.applicant = new ProviderActiveApplicantSummaryDto(
      application.applicant,
      application.applicant.profile,
      application.warnings,
    );
  }
}
