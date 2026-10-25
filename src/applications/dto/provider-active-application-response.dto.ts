import type {
  ApplicantProfile,
  Application,
  User,
} from '../../generated/prisma/client';
import type { ApplicationConsiderationSummary } from '../application-consideration-read';
import type { ApplicationAttentionSummaryDto } from '../../application-attention/dto/attention-response.dto';
import type { EligibilityWarning } from '../../eligibility/dto/eligibility-response.dto';

export type ProviderActiveApplicationRecord = Pick<
  Application,
  'id' | 'listingId' | 'status' | 'activeAt'
> & {
  consideration?: ApplicationConsiderationSummary;
  applicant: Pick<User, 'name'> & {
    profile: Pick<ApplicantProfile, 'peopleCount' | 'introduction'> | null;
  };
  warnings: EligibilityWarning[];
};

export class ProviderActiveApplicantSummaryDto {
  readonly name: string;
  readonly peopleCount: number | null;
  readonly introduction: string | null;
  readonly warnings: EligibilityWarning[];

  constructor(
    applicant: Pick<User, 'name'>,
    profile: Pick<ApplicantProfile, 'peopleCount' | 'introduction'> | null,
    warnings: EligibilityWarning[],
  ) {
    this.name = applicant.name;
    this.peopleCount = profile?.peopleCount ?? null;
    this.introduction = profile?.introduction ?? null;
    this.warnings = warnings;
  }
}

export class ProviderActiveApplicationResponseDto {
  readonly viewing: ApplicationAttentionSummaryDto['viewing'];
  readonly consideration: ApplicationConsiderationSummary;
  readonly id: string;
  readonly listingId: string;
  readonly status: Application['status'];
  readonly activeAt: Date | null;
  readonly applicant: ProviderActiveApplicantSummaryDto;

  constructor(
    application: ProviderActiveApplicationRecord,
    readonly attention: ApplicationAttentionSummaryDto,
  ) {
    this.id = application.id;
    this.viewing = attention.viewing;
    this.consideration = application.consideration ?? {
      position: null,
      revision: 0,
      applicantNoShow: null,
    };
    this.listingId = application.listingId;
    this.status = application.status;
    this.activeAt = application.activeAt;
    this.applicant = new ProviderActiveApplicantSummaryDto(
      application.applicant,
      application.applicant.profile,
      application.warnings,
    );
  }
}
