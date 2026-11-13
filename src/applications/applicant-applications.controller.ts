import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';

import { ApplicationsService } from './applications.service';
import { ApplicantApplicationResponseDto } from './dto/applicant-application-response.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications')
export class ApplicantApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Get()
  async findAll(
    @Req() request: Request,
  ): Promise<ApplicantApplicationResponseDto[]> {
    const applications =
      await this.applicationsService.findAllByApplicantWithListing(
        sessionAuthorityFromRequest(request),
      );
    return applications.map(
      (application) => new ApplicantApplicationResponseDto(application),
    );
  }
}
