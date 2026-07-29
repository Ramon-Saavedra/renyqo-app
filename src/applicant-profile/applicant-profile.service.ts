import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

import type { ApplicantProfile, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

const SERIALIZABLE_TRANSACTION_RETRIES = 8;

type TransactionClient = Prisma.TransactionClient;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isP2034(error: unknown): boolean {
  if (
    error instanceof PrismaClientKnownRequestError &&
    error.code === 'P2034'
  ) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  if (error.code === 'P2034') {
    return true;
  }

  const meta = isRecord(error.meta) ? error.meta : undefined;
  const driverAdapterError = meta?.driverAdapterError;
  if (
    isRecord(driverAdapterError) &&
    isRecord(driverAdapterError.cause) &&
    driverAdapterError.cause.originalCode === '40001'
  ) {
    return true;
  }

  return false;
}

@Injectable()
export class ApplicantProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async findByApplicant(applicantId: string): Promise<ApplicantProfile | null> {
    return this.prisma.applicantProfile.findUnique({ where: { applicantId } });
  }

  async upsert(
    applicantId: string,
    dto: UpdateApplicantProfileDto,
  ): Promise<ApplicantProfile> {
    this.assertHasMeaningfulData(dto);

    const normalized = this.normalizeDto(dto);

    return this.runSerializableTransaction(async (tx) => {
      const existing = await tx.applicantProfile.findUnique({
        where: { applicantId },
      });

      const merged = this.mergeProfile(existing, normalized);
      this.assertHouseholdConsistency(merged);
      const peopleCount = this.calculatePeopleCount(merged);

      return tx.applicantProfile.upsert({
        where: { applicantId },
        create: { applicantId, ...merged, peopleCount },
        update: { ...merged, peopleCount },
      });
    });
  }

  private assertHasMeaningfulData(dto: UpdateApplicantProfileDto): void {
    const hasData = Object.values(dto).some((value) => value !== undefined);

    if (!hasData) {
      throw new BadRequestException('At least one profile field is required');
    }
  }

  private normalizeDto(
    dto: UpdateApplicantProfileDto,
  ): UpdateApplicantProfileDto {
    const normalized: UpdateApplicantProfileDto = {};

    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) {
        continue;
      }

      normalized[key as keyof UpdateApplicantProfileDto] = value as never;
    }

    return normalized;
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
      petsNote:
        dto.petsNote !== undefined
          ? dto.petsNote
          : (existing?.petsNote ?? null),
      smokingStatus:
        dto.smokingStatus !== undefined
          ? dto.smokingStatus
          : (existing?.smokingStatus ?? null),
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

  private async runSerializableTransaction<T>(
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < SERIALIZABLE_TRANSACTION_RETRIES;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: 'Serializable',
        });
      } catch (err) {
        if (!isP2034(err) || attempt === SERIALIZABLE_TRANSACTION_RETRIES - 1) {
          throw err;
        }
        const delayMs = Math.min(250, 10 * 2 ** attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error('Unreachable: retry loop exhausted');
  }
}
