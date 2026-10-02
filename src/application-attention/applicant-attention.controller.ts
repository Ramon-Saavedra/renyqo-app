import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { SafeUser } from '../users/types/safe-user.type';
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
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.detail(user.id, 'applicant', params.applicationId);
  }

  @Get('attention')
  aggregate(@Query() query: AttentionQueryDto, @CurrentUser() user: SafeUser) {
    return this.queries.aggregate(user.id, 'applicant', query);
  }
}
