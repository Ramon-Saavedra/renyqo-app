import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
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
import { ViewingOutcome } from '../generated/prisma/enums';
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

@UseGuards(AuthenticatedGuard)
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
    @Req() request: Request,
  ) {
    return this.queries.list(
      params.applicationId,
      providerActorFromRequest(request),
      'provider',
      query,
    );
  }
  @Get(':viewingId') detail(
    @Param() params: ViewingParamsDto,
    @Req() request: Request,
  ) {
    return this.queries.detail(
      params.applicationId,
      params.viewingId,
      providerActorFromRequest(request),
      'provider',
    );
  }
  @Post() propose(
    @Param() params: ViewingApplicationParamsDto,
    @Body() dto: ProposeViewingDto,
    @Req() request: Request,
  ) {
    return this.viewings.propose(
      params.applicationId,
      providerActorFromRequest(request),
      dto,
    );
  }
  @Post(':viewingId/reschedule') reschedule(
    @Param() params: ViewingParamsDto,
    @Body() dto: ProposeViewingDto,
    @Req() request: Request,
  ) {
    return this.viewings.propose(
      params.applicationId,
      providerActorFromRequest(request),
      dto,
      params.viewingId,
    );
  }
  @Patch(':viewingId/cancel') cancel(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @Req() request: Request,
  ) {
    return this.viewings.respond(
      params.applicationId,
      params.viewingId,
      providerActorFromRequest(request),
      'cancel',
    );
  }
  @Patch(':viewingId/complete') complete(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @Req() request: Request,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      providerActorFromRequest(request),
      ViewingOutcome.COMPLETED,
    );
  }
  @Patch(':viewingId/no-show') noShow(
    @Param() params: ViewingParamsDto,
    @Body() _dto: ViewingActionDto,
    @Req() request: Request,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      providerActorFromRequest(request),
      ViewingOutcome.NO_SHOW,
    );
  }
  @Patch(':viewingId/correct-outcome') correct(
    @Param() params: ViewingParamsDto,
    @Body() dto: CorrectViewingOutcomeDto,
    @Req() request: Request,
  ) {
    return this.outcomes.record(
      params.applicationId,
      params.viewingId,
      providerActorFromRequest(request),
      dto.outcome,
      dto,
    );
  }
}
