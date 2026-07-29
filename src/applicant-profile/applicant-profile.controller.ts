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
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicantProfileService } from './applicant-profile.service';
import { ApplicantProfileResponseDto } from './dto/applicant-profile-response.dto';
import { UpdateApplicantProfileDto } from './dto/update-applicant-profile.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/profile')
export class ApplicantProfileController {
  constructor(
    private readonly applicantProfileService: ApplicantProfileService,
  ) {}

  @Get()
  async getProfile(
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicantProfileResponseDto> {
    const profile = await this.applicantProfileService.findByApplicant(user.id);

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    return new ApplicantProfileResponseDto(profile);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @CurrentUser() user: SafeUser,
    @Body() dto: UpdateApplicantProfileDto,
  ): Promise<ApplicantProfileResponseDto> {
    const profile = await this.applicantProfileService.upsert(user.id, dto);

    return new ApplicantProfileResponseDto(profile);
  }
}
