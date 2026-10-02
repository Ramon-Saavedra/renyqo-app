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
import { ApplicantOnlyGuard } from '../common/guards/applicant-only.guard';
import { ConversationSide } from '../generated/prisma/enums';
import type { SafeUser } from '../users/types/safe-user.type';
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

@UseGuards(AuthenticatedGuard, ApplicantOnlyGuard)
@Controller('applicant/applications/:applicationId/conversation')
export class ApplicantConversationController {
  constructor(private readonly conversations: ApplicationConversationService) {}

  @Get('summary')
  summary(
    @Param() params: ApplicationConversationParamsDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ConversationSummaryResponseDto> {
    return this.conversations.summary(
      params.applicationId,
      user.id,
      ConversationSide.APPLICANT,
    );
  }

  @Get()
  detail(
    @Param() params: ApplicationConversationParamsDto,
    @Query() query: ConversationQueryDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ConversationDetailResponseDto> {
    return this.conversations.detail(
      params.applicationId,
      user.id,
      ConversationSide.APPLICANT,
      query,
    );
  }

  @Post('messages')
  send(
    @Param() params: ApplicationConversationParamsDto,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: SafeUser,
  ): Promise<ApplicationMessageResponseDto> {
    return this.conversations.send(
      params.applicationId,
      user.id,
      ConversationSide.APPLICANT,
      dto.body,
    );
  }

  @Patch('read')
  markRead(
    @Param() params: ApplicationConversationParamsDto,
    @Body() dto: MarkConversationReadDto,
    @CurrentUser() user: SafeUser,
  ): Promise<MarkConversationReadResponseDto> {
    return this.conversations.markRead(
      params.applicationId,
      user.id,
      ConversationSide.APPLICANT,
      dto.throughSequence,
    );
  }
}
