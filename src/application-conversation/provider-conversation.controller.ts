import { Req } from '@nestjs/common';
import type { Request } from 'express';
import { providerActorFromRequest } from '../provider-authorization/provider-listing-access';
import { ApplicationConversationPermissionService } from './application-conversation-permission.service';
import { SetApplicantRepliesDto } from './dto/set-applicant-replies.dto';
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
import { ConversationSide } from '../generated/prisma/enums';
import { ApplicationConversationService } from './application-conversation.service';
import { ApplicationConversationParamsDto } from './dto/application-conversation-params.dto';
import { ConversationQueryDto } from './dto/conversation-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MarkConversationReadDto } from './dto/mark-conversation-read.dto';
import {
  ApplicationMessageResponseDto,
  ConversationDetailResponseDto,
  ConversationSummaryResponseDto,
  MarkConversationReadResponseDto,
} from './dto/conversation-response.dto';

@UseGuards(AuthenticatedGuard)
@Controller('provider/applications/:applicationId/conversation')
export class ProviderConversationController {
  constructor(
    private readonly conversations: ApplicationConversationService,
    private readonly permissions: ApplicationConversationPermissionService,
  ) {}

  @Patch('applicant-replies')
  setApplicantReplies(
    @Param() params: ApplicationConversationParamsDto,
    @Req() request: Request,
    @Body() dto: SetApplicantRepliesDto,
  ) {
    return this.permissions.setApplicantReplies(
      params.applicationId,
      providerActorFromRequest(request),
      dto.applicantRepliesEnabled,
    );
  }

  @Get('summary')
  summary(
    @Param() params: ApplicationConversationParamsDto,
    @Req() request: Request,
  ): Promise<ConversationSummaryResponseDto> {
    return this.conversations.summary(
      params.applicationId,
      providerActorFromRequest(request),
      ConversationSide.PROVIDER,
    );
  }

  @Get()
  detail(
    @Param() params: ApplicationConversationParamsDto,
    @Query() query: ConversationQueryDto,
    @Req() request: Request,
  ): Promise<ConversationDetailResponseDto> {
    return this.conversations.detail(
      params.applicationId,
      providerActorFromRequest(request),
      ConversationSide.PROVIDER,
      query,
    );
  }

  @Post('messages')
  send(
    @Param() params: ApplicationConversationParamsDto,
    @Body() dto: SendMessageDto,
    @Req() request: Request,
  ): Promise<ApplicationMessageResponseDto> {
    return this.conversations.send(
      params.applicationId,
      providerActorFromRequest(request),
      ConversationSide.PROVIDER,
      dto.body,
    );
  }

  @Patch('read')
  markRead(
    @Param() params: ApplicationConversationParamsDto,
    @Body() dto: MarkConversationReadDto,
    @Req() request: Request,
  ): Promise<MarkConversationReadResponseDto> {
    return this.conversations.markRead(
      params.applicationId,
      providerActorFromRequest(request),
      ConversationSide.PROVIDER,
      dto.throughSequence,
    );
  }
}
