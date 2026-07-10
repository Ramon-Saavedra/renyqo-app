import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { ApplicantProfile } from '../generated/prisma/client';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantProfileService } from './applicant-profile.service';
import { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/profile')
export class ApplicantProfileController {
  constructor(
    private readonly applicantProfileService: ApplicantProfileService,
  ) {}

  @Get()
  async getProfile(@CurrentUser() user: SafeUser): Promise<ApplicantProfile> {
    const profile = await this.applicantProfileService.findByApplicant(user.id);

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    return profile;
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  updateProfile(
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateApplicantProfileDto,
  ): Promise<ApplicantProfile> {
    return this.applicantProfileService.upsert(user.id, dto);
  }
}
