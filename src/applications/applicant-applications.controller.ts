import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto } from './dto/application-response.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications')
export class ApplicantApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get()
  async findAll(
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationResponseDto[]> {
    const applications = await this.applicationsService.findAllByApplicant(
      user.id,
    );
    return applications.map(
      (application) => new ApplicationResponseDto(application),
    );
  }
}
