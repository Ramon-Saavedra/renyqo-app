import { BadRequestException, Injectable } from '@nestjs/common';

import { ApplicationsService } from '../applications/applications.service';
import type { ApplicantProfile } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import type { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

@Injectable()
export class ApplicantProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applicationsService: ApplicationsService,
  ) {}

  async findByApplicant(applicantId: string): Promise<ApplicantProfile | null> {
    return this.prisma.applicantProfile.findUnique({ where: { applicantId } });
  }

  async upsert(
    applicantId: string,
    dto: UpdateApplicantProfileDto,
  ): Promise<ApplicantProfile> {
    this.assertHasMeaningfulData(dto);

    return runSerializableTransaction(
      this.prisma,
      async (tx) => {
        const existing = await tx.applicantProfile.findUnique({
          where: { applicantId },
        });

        const merged = this.mergeProfile(existing, dto);
        this.assertHouseholdConsistency(merged);
        const peopleCount = this.calculatePeopleCount(merged);

        const profile = await tx.applicantProfile.upsert({
          where: { applicantId },
          create: { applicantId, ...merged, peopleCount },
          update: { ...merged, peopleCount },
        });

        await this.applicationsService.revalidateActiveAndWaitingApplications(
          tx,
          applicantId,
          profile,
        );

        return profile;
      },
      { fallbackMessage: 'Profile update could not be completed' },
    );
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
