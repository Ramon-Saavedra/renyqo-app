import { ViewingWorkflowHistoryQueryService } from './viewing-workflow-history-query.service';
import { ViewingQueryDto } from './dto/viewing-input.dto';
import {
  Body,
  Controller,
  Get,
  Query,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedGuard } from '../auth/guards/authenticated.guard';
import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { sessionAuthorityFromRequest } from '../provider-authorization/domain/authority-reference';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';

import { ViewingApplicationParamsDto } from './dto/viewing-input.dto';
import {
  WorkflowCommandDto,
  WorkflowProposalParamsDto,
  WorkflowScheduleDto,
  WorkflowAppointmentParamsDto,
  WorkflowCancelDto,
} from './dto/workflow-command.dto';
import { ViewingWorkflowCommandService } from './viewing-workflow-command.service';
import { WorkflowInterestDto } from './dto/workflow-command.dto';

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications/:applicationId/viewing-workflow')
export class ApplicantViewingWorkflowController {
  constructor(
    private readonly commands: ViewingWorkflowCommandService,
    private readonly history: ViewingWorkflowHistoryQueryService,
  ) {}
  @Get('proposals') proposals(
    @Param() params: ViewingApplicationParamsDto,
    @Query() query: ViewingQueryDto,
    @Req() request: Request,
  ) {
    return this.history.proposals(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      query,
    );
  }
  @Get('proposals/:proposalId') proposal(
    @Param() params: WorkflowProposalParamsDto,
    @Req() request: Request,
  ) {
    return this.history.proposals(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      new ViewingQueryDto(),
      params.proposalId,
    );
  }
  @Post('appointments/:appointmentId/interest')
  @HttpCode(200)
  interest(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowInterestDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'interest',
        appointmentId: params.appointmentId,
        body,
      },
    );
  }
  @Get() snapshot(
    @Param() params: ViewingApplicationParamsDto,
    @Req() request: Request,
  ) {
    return this.commands.snapshot(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
    );
  }
  @Post('reconcile')
  @HttpCode(200)
  reconcile(
    @Param() params: ViewingApplicationParamsDto,
    @Body() body: WorkflowCommandDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'reconcile',
        body,
      },
    );
  }
  @Post('proposals/:proposalId/accept')
  @HttpCode(200)
  accept(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'accept',
        proposalId: params.proposalId,
        body,
      },
    );
  }
  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  reject(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'reject',
        proposalId: params.proposalId,
        body,
      },
    );
  }
  @Post('proposals/:proposalId/alternative')
  @HttpCode(200)
  alternative_proposal(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowScheduleDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'alternative-proposal',
        proposalId: params.proposalId,
        body,
      },
    );
  }
  @Post('appointments/:appointmentId/alternative')
  @HttpCode(200)
  alternative_appointment(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowScheduleDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'alternative-appointment',
        appointmentId: params.appointmentId,
        body,
      },
    );
  }
  @Post('proposals/:proposalId/withdraw')
  @HttpCode(200)
  withdraw(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'withdraw',
        proposalId: params.proposalId,
        body,
      },
    );
  }
  @Post('appointments/:appointmentId/cancel')
  @HttpCode(200)
  cancel(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowCancelDto,
    @Req() request: Request,
  ) {
    return this.commands.execute(
      params.applicationId,
      sessionAuthorityFromRequest(request),
      'applicant',
      {
        action: 'cancel',
        appointmentId: params.appointmentId,
        body,
      },
    );
  }
}
