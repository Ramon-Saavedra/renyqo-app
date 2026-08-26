import type {
  ApplicantProfile,
  Application,
  User,
} from '../../generated/prisma/client';

export type ProviderActiveApplicantProfileFields = Pick<
  ApplicantProfile,
  'peopleCount'
>;

export type ProviderActiveApplicationRecord = Pick<
  Application,
  'id' | 'listingId' | 'status'
> & {
  applicant: Pick<User, 'name'> & {
    profile: ProviderActiveApplicantProfileFields | null;
  };
};

export class ProviderActiveApplicantSummaryDto {
  readonly name: string;
  readonly peopleCount: number | null;

  constructor(
    applicant: Pick<User, 'name'>,
    profile: ProviderActiveApplicantProfileFields | null,
  ) {
    this.name = applicant.name;
    this.peopleCount = profile?.peopleCount ?? null;
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
    );
  }
}
