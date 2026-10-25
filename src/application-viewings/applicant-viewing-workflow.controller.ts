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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
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
    @CurrentUser() user: SafeUser,
  ) {
    return this.history.proposals(
      params.applicationId,
      user.id,
      'applicant',
      query,
    );
  }
  @Get('proposals/:proposalId') proposal(
    @Param() params: WorkflowProposalParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.history.proposals(
      params.applicationId,
      user.id,
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
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'interest',
      appointmentId: params.appointmentId,
      body,
    });
  }
  @Get() snapshot(
    @Param() params: ViewingApplicationParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.snapshot(params.applicationId, user.id, 'applicant');
  }
  @Post('reconcile')
  @HttpCode(200)
  reconcile(
    @Param() params: ViewingApplicationParamsDto,
    @Body() body: WorkflowCommandDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'reconcile',
      body,
    });
  }
  @Post('proposals/:proposalId/accept')
  @HttpCode(200)
  accept(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'accept',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('proposals/:proposalId/reject')
  @HttpCode(200)
  reject(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'reject',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('proposals/:proposalId/alternative')
  @HttpCode(200)
  alternative_proposal(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowScheduleDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'alternative-proposal',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('appointments/:appointmentId/alternative')
  @HttpCode(200)
  alternative_appointment(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowScheduleDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'alternative-appointment',
      appointmentId: params.appointmentId,
      body,
    });
  }
  @Post('proposals/:proposalId/withdraw')
  @HttpCode(200)
  withdraw(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowCommandDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'withdraw',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('appointments/:appointmentId/cancel')
  @HttpCode(200)
  cancel(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowCancelDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'applicant', {
      action: 'cancel',
      appointmentId: params.appointmentId,
      body,
    });
  }
}
