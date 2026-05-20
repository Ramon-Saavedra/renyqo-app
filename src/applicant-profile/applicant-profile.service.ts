import { Injectable } from '@nestjs/common';

import type { ApplicantProfile } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

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
    return this.prisma.applicantProfile.upsert({
      where: { applicantId },
      create: { applicantId, ...dto },
      update: { ...dto },
    });
  }
}
