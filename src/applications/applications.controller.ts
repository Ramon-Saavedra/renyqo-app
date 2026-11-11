import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';

import { ApplicationsService } from './applications.service';
import { ApplicationResponseDto } from './dto/application-response.dto';
import { ApplicantApplicationActionThrottlerGuard } from './guards/applicant-application-action-throttler.guard';

@UseGuards(
  AuthenticatedGuard,
  ApplicantOnlyGuard,
  ApplicantApplicationActionThrottlerGuard,
)
@Controller('listings')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post(':id/apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<ApplicationResponseDto> {
    const application = await this.applicationsService.apply(
      listingId,
      sessionAuthorityFromRequest(request),
    );
    return new ApplicationResponseDto(application);
  }
}
