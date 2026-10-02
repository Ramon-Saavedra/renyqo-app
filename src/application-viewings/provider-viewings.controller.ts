import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import { ViewingOutcome } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
import { ApplicationViewingService } from './application-viewing.service';
import { ApplicationViewingOutcomeService } from './application-viewing-outcome.service';
import { ApplicationViewingQueryService } from './application-viewing-query.service';
import {
  CorrectViewingOutcomeDto,
  ProposeViewingDto,
  ViewingActionDto,
  ViewingApplicationParamsDto,
  ViewingParamsDto,
  ViewingQueryDto,
} from './dto/viewing-input.dto';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/applications/:applicationId/viewings')
export class ProviderViewingsController {
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
    return this.queries.list(params.applicationId, user.id, 'provider', query);
  }
  @Get(':viewingId') detail(
    @Param() params: ViewingParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.queries.detail(
      params.applicationId,
      params.viewingId,
      user.id,
      'provider',
    );
  }
  @Post() propose(
    @Param() params: ViewingApplicationParamsDto,
    @Body() dto: ProposeViewingDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.propose(params.applicationId, user.id, dto);
  }
  @Post(':viewingId/reschedule') reschedule(
    @Param() params: ViewingParamsDto,
    @Body() dto: ProposeViewingDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.propose(
      params.applicationId,
      user.id,
      dto,
      params.viewingId,
    );
  }
  @Patch(':viewingId/cancel') cancel(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      user.id,
      'cancel',
    );
  }
  @Patch(':viewingId/complete') complete(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      user.id,
      ViewingOutcome.COMPLETED,
    );
  }
  @Patch(':viewingId/no-show') noShow(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      user.id,
      ViewingOutcome.NO_SHOW,
    );
  }
  @Patch(':viewingId/correct-outcome') correct(
    @Param() params: ViewingParamsDto,
    @Body() dto: CorrectViewingOutcomeDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      user.id,
      dto.outcome,
      dto,
    );
  }
}
