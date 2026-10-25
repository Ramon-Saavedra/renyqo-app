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
import { ProviderOnlyGuard } from '../common/guards/provider-only.guard';
import type { SafeUser } from '../users/types/safe-user.type';
import { ViewingApplicationParamsDto } from './dto/viewing-input.dto';
import {
  WorkflowCommandDto,
  WorkflowScheduleDto,
  WorkflowProposalParamsDto,
  WorkflowAppointmentParamsDto,
  WorkflowCloseParamsDto,
  WorkflowCloseDto,
} from './dto/workflow-command.dto';
import { ViewingWorkflowCommandService } from './viewing-workflow-command.service';
import {
  WorkflowConsiderationDto,
  WorkflowOutcomeDto,
} from './dto/workflow-command.dto';

@UseGuards(AuthenticatedGuard, ProviderOnlyGuard)
@Controller('provider/applications/:applicationId/viewing-workflow')
export class ProviderViewingWorkflowController {
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
      'provider',
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
      'provider',
      new ViewingQueryDto(),
      params.proposalId,
    );
  }
  @Post('appointments/:appointmentId/consideration')
  @HttpCode(200)
  consideration(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowConsiderationDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'consideration',
      appointmentId: params.appointmentId,
      body,
    });
  }
  @Post('appointments/:appointmentId/outcome')
  @HttpCode(200)
  outcome(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowOutcomeDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'outcome',
      appointmentId: params.appointmentId,
      body,
    });
  }
  @Get() snapshot(
    @Param() params: ViewingApplicationParamsDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.snapshot(params.applicationId, user.id, 'provider');
  }
  @Post('reconcile')
  @HttpCode(200)
  reconcile(
    @Param() params: ViewingApplicationParamsDto,
    @Body() body: WorkflowCommandDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'reconcile',
      body,
    });
  }
  @Post('invitations')
  @HttpCode(200)
  invite(
    @Param() params: ViewingApplicationParamsDto,
    @Body() body: WorkflowScheduleDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'invite',
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
    return this.commands.execute(params.applicationId, user.id, 'provider', {
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
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'reject',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('proposals/:proposalId/counterproposal')
  @HttpCode(200)
  counterproposal(
    @Param() params: WorkflowProposalParamsDto,
    @Body() body: WorkflowScheduleDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'counterproposal',
      proposalId: params.proposalId,
      body,
    });
  }
  @Post('appointments/:appointmentId/replacement')
  @HttpCode(200)
  replacement(
    @Param() params: WorkflowAppointmentParamsDto,
    @Body() body: WorkflowScheduleDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'replacement',
      appointmentId: params.appointmentId,
      body,
    });
  }
  @Post(':workflowId/close')
  @HttpCode(200)
  close(
    @Param() params: WorkflowCloseParamsDto,
    @Body() body: WorkflowCloseDto,
    @CurrentUser() user: SafeUser,
  ) {
    return this.commands.execute(params.applicationId, user.id, 'provider', {
      action: 'close',
      workflowId: params.workflowId,
      body,
    });
  }
}
