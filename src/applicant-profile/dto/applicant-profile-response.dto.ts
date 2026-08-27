import type { ApplicantProfile } from '../../generated/prisma/client';

export class ApplicantProfileResponseDto {
  readonly householdNetIncome: number | null;
  readonly incomeProofAvailable: boolean | null;
  readonly schufaAvailable: boolean | null;
  readonly peopleCount: number | null;
  readonly adultsCount: number | null;
  readonly childrenCount: number | null;
  readonly hasPets: boolean | null;
  readonly isSmoker: boolean | null;

  constructor(profile: ApplicantProfile) {
    this.householdNetIncome = profile.householdNetIncome;
    this.incomeProofAvailable = profile.incomeProofAvailable;
    this.schufaAvailable = profile.schufaAvailable;
    this.peopleCount = profile.peopleCount;
    this.adultsCount = profile.adultsCount;
    this.childrenCount = profile.childrenCount;
    this.hasPets = profile.hasPets;
    this.isSmoker = profile.isSmoker;
  }
}
