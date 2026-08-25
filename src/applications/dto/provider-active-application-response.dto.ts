import type {
  ApplicantProfile,
  Application,
  User,
} from '../../generated/prisma/client';
import type { ApplicationRejectionReason } from '../../generated/prisma/enums';

export type ProviderActiveApplicantProfileFields = Pick<
  ApplicantProfile,
  | 'peopleCount'
  | 'adultsCount'
  | 'childrenCount'
  | 'householdNetIncome'
  | 'incomeProofAvailable'
  | 'schufaAvailable'
  | 'hasPets'
  | 'petsNote'
  | 'smokingStatus'
>;

export type ProviderActiveApplicationRecord = Pick<
  Application,
  | 'id'
  | 'listingId'
  | 'applicantId'
  | 'status'
  | 'rejectedAt'
  | 'publicReason'
  | 'createdAt'
  | 'updatedAt'
> & {
  applicant: Pick<User, 'name' | 'email'> & {
    profile: ProviderActiveApplicantProfileFields | null;
  };
};

export class ProviderActiveApplicantSummaryDto {
  readonly name: string;
  readonly email: string;
  readonly peopleCount: number | null;
  readonly adultsCount: number | null;
  readonly childrenCount: number | null;
  readonly householdNetIncome: number | null;
  readonly incomeProofAvailable: boolean | null;
  readonly schufaAvailable: boolean | null;
  readonly hasPets: boolean | null;
  readonly petsNote: string | null;
  readonly smokingStatus: ApplicantProfile['smokingStatus'];

  constructor(
    applicant: Pick<User, 'name' | 'email'>,
    profile: ProviderActiveApplicantProfileFields | null,
  ) {
    this.name = applicant.name;
    this.email = applicant.email;
    this.peopleCount = profile?.peopleCount ?? null;
    this.adultsCount = profile?.adultsCount ?? null;
    this.childrenCount = profile?.childrenCount ?? null;
    this.householdNetIncome = profile?.householdNetIncome ?? null;
    this.incomeProofAvailable = profile?.incomeProofAvailable ?? null;
    this.schufaAvailable = profile?.schufaAvailable ?? null;
    this.hasPets = profile?.hasPets ?? null;
    this.petsNote = profile?.petsNote ?? null;
    this.smokingStatus = profile?.smokingStatus ?? null;
  }
}

export class ProviderActiveApplicationResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly applicantId: string;
  readonly status: Application['status'];
  readonly rejectedAt: Date | null;
  readonly publicReason: ApplicationRejectionReason | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly applicant: ProviderActiveApplicantSummaryDto;

  constructor(application: ProviderActiveApplicationRecord) {
    this.id = application.id;
    this.listingId = application.listingId;
    this.applicantId = application.applicantId;
    this.status = application.status;
    this.rejectedAt = application.rejectedAt;
    this.publicReason = application.publicReason;
    this.createdAt = application.createdAt;
    this.updatedAt = application.updatedAt;
    this.applicant = new ProviderActiveApplicantSummaryDto(
      application.applicant,
      application.applicant.profile,
    );
  }
}
