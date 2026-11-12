import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { ApplicantEligibilityResponseDto } from './dto/applicant-eligibility-response.dto';
import { EligibilityService } from './eligibility.service';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('listings')
export class EligibilityController {
  constructor(private readonly eligibilityService: EligibilityService) {}

  @Get(':id/eligibility')
  async check(
    @Param('id', new ParseUUIDPipe({ version: '4' })) listingId: string,
    @Req() request: Request,
  ): Promise<ApplicantEligibilityResponseDto> {
    return new ApplicantEligibilityResponseDto(
      await this.eligibilityService.check(
        listingId,
        sessionAuthorityFromRequest(request),
      ),
    );
  }
}
