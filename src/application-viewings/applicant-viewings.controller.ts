import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationViewingService } from './application-viewing.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import {
  RequestViewingChangeDto,
  SubmitViewingInterestDto,
  ViewingActionDto,
  ViewingApplicationParamsDto,
  ViewingParamsDto,
  ViewingQueryDto,
} from './dto/viewing-input.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications/:applicationId/viewings')
export class ApplicantViewingsController {
  constructor(
    private readonly viewings: ApplicationViewingService,
    private readonly outcomes: ApplicationViewingOutcomeService,
    private readonly queries: ApplicationViewingQueryService,
  ) {}
  @Get() list(
    @Param() params: ViewingApplicationParamsDto,
    @Query() query: ViewingQueryDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.list(params.applicationId, user.id, 'applicant', query);
  }
  @Get(':viewingId') detail(
    @Param() params: ViewingParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.detail(
      params.applicationId,
      params.viewingId,
      user.id,
      'applicant',
    );
  }
  @Patch(':viewingId/accept') accept(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      user.id,
      'accept',
    );
  }
  @Patch(':viewingId/decline') decline(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      user.id,
      'decline',
    );
  }
  @Patch(':viewingId/request-another-time') requestChange(
    @Param() params: ViewingParamsDto,
    @Body() dto: RequestViewingChangeDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      user.id,
      'request-change',
      dto,
    );
  }
  @Patch(':viewingId/interest') interest(
    @Param() params: ViewingParamsDto,
    @Body() dto: SubmitViewingInterestDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.outcomes.interest(
      params.applicationId,
      params.viewingId,
      user.id,
      dto.interest,
    );
  }
}
