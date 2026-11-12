import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';

import { ApplicationAttentionQueryService } from './application-attention-query.service';
import {
  AttentionApplicationParamsDto,
  AttentionQueryDto,
} from './dto/attention-input.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant')
export class ApplicantAttentionController {
  constructor(private readonly queries: ApplicationAttentionQueryService) {}

  @Get('applications/:applicationId/attention')
  detail(
    @Param() params: AttentionApplicationParamsDto,
    @Req() request: Request,
  ) {
    return this.queries.detail(
      sessionAuthorityFromRequest(request),
      'applicant',
      params.applicationId,
    );
  }

  @Get('attention')
  aggregate(@Query() query: AttentionQueryDto, @Req() request: Request) {
    return this.queries.aggregate(
      sessionAuthorityFromRequest(request),
      'applicant',
      query,
    );
  }
}
