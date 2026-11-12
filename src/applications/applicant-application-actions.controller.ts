import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';

import { ApplicationsService } from './applications.service';
import { ApplicantApplicationStatusResponseDto } from './dto/applicant-application-status-response.dto';
import { ApplicantApplicationActionThrottlerGuard } from './guards/applicant-application-action-throttler.guard';

@UseGuards(
  AuthenticatedGuard,
  ApplicantOnlyGuard,
  ApplicantApplicationActionThrottlerGuard,
)
@Controller('applicant/applications')
export class ApplicantApplicationActionsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @Param('id', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Req() request: Request,
  ): Promise<ApplicantApplicationStatusResponseDto> {
    const application = await this.applicationsService.withdraw(
      applicationId,
      sessionAuthorityFromRequest(request),
    );
    return new ApplicantApplicationStatusResponseDto(application);
  }
}
