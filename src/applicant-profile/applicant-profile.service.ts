import { BadRequestException, Injectable } from '@nestjs/common';

import { ApplicationLifecycleService } from '../applications/application-lifecycle.service';
import type { ApplicantProfile } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { ProfileRevalidationTransactions } from './profile-revalidation-transactions';
import type { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

@Injectable()
export class ApplicantProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationLifecycleService: ApplicationLifecycleService,
    private readonly revalidation: ProfileRevalidationTransactions,
  ) {}

  async findByApplicant(applicantId: string): Promise<ApplicantProfile | null> {
    return this.prisma.applicantProfile.findUnique({ where: { applicantId } });
  }

  async upsert(
    authority: HumanAuthority,
    dto: UpdateApplicantProfileDto,
  ): Promise<ApplicantProfile> {
    this.assertHasMeaningfulData(dto);
    const applicantId = authority.userId;
    return this.revalidation.run(authority, async (tx, listings) => {
      const existing = await tx.applicantProfile.findUnique({
        where: { applicantId },
      });

      const merged = this.mergeProfile(existing, dto);
      this.assertRequiredIntroduction(existing, merged.introduction);
      this.assertHouseholdConsistency(merged);
      const peopleCount = this.calculatePeopleCount(merged);

      const profile = await tx.applicantProfile.upsert({
        where: { applicantId },
        create: { applicantId, ...merged, peopleCount },
        update: { ...merged, peopleCount },
      });

      await this.applicationLifecycleService.revalidateActiveAndWaitingApplications(
        tx,
        applicantId,
        profile,
        listings,
      );

      return profile;
    });
  }

  private assertHasMeaningfulData(dto: UpdateApplicantProfileDto): void {
    const hasData = Object.values(dto).some((value) => value !== undefined);

    if (!hasData) {
      throw new BadRequestException('At least one profile field is required');
    }
  }

  private mergeProfile(
    existing: ApplicantProfile | null,
    dto: UpdateApplicantProfileDto,
  ): Omit<
    ApplicantProfile,
    'id' | 'applicantId' | 'peopleCount' | 'createdAt' | 'updatedAt'
  > {
    return {
      introduction:
        dto.introduction !== undefined
          ? (dto.introduction?.trim() ?? null)
          : (existing?.introduction ?? null),
      householdNetIncome:
        dto.householdNetIncome !== undefined
          ? dto.householdNetIncome
          : (existing?.householdNetIncome ?? null),
      incomeProofAvailable:
        dto.incomeProofAvailable !== undefined
          ? dto.incomeProofAvailable
          : (existing?.incomeProofAvailable ?? null),
      schufaAvailable:
        dto.schufaAvailable !== undefined
          ? dto.schufaAvailable
          : (existing?.schufaAvailable ?? null),
      adultsCount:
        dto.adultsCount !== undefined
          ? dto.adultsCount
          : (existing?.adultsCount ?? null),
      childrenCount:
        dto.childrenCount !== undefined
          ? dto.childrenCount
          : (existing?.childrenCount ?? null),
      hasPets:
        dto.hasPets !== undefined ? dto.hasPets : (existing?.hasPets ?? null),
      isSmoker:
        dto.isSmoker !== undefined
          ? dto.isSmoker
          : (existing?.isSmoker ?? null),
    };
  }

  private assertRequiredIntroduction(
    existing: ApplicantProfile | null,
    introduction: string | null,
  ): void {
    if (introduction === null || introduction.trim().length === 0) {
      if (!existing || existing.introduction === null) {
        throw new BadRequestException(
          'A personal introduction is required for the applicant profile',
        );
      }

      throw new BadRequestException('Introduction cannot be empty');
    }
  }

  private assertHouseholdConsistency(data: {
    adultsCount?: number | null;
    childrenCount?: number | null;
  }): void {
    const adultsPresent = data.adultsCount != null;
    const childrenPresent = data.childrenCount != null;

    if (adultsPresent !== childrenPresent) {
      throw new BadRequestException(
        'adultsCount and childrenCount must be specified together',
      );
    }
  }

  private calculatePeopleCount(data: {
    adultsCount?: number | null;
    childrenCount?: number | null;
  }): number | null {
    if (data.adultsCount != null && data.childrenCount != null) {
      return data.adultsCount + data.childrenCount;
    }

    return null;
  }
}
