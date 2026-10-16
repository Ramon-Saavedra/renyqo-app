import {
  CompactConversationSummaryDto,
  type ConversationCapabilities,
} from './compact-conversation-summary.dto';
import type { ApplicationMessage } from '../../generated/prisma/client';
import type { ConversationSide } from '../../generated/prisma/enums';

export class ApplicationMessageResponseDto {
  readonly id: string;
  readonly sequence: number;
  readonly senderType: ConversationSide;
  readonly body: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;

  constructor(message: ApplicationMessage) {
    this.id = message.id;
    this.sequence = message.sequence;
    this.senderType = message.senderType;
    this.body = message.body;
    this.createdAt = message.createdAt;
    this.readAt = message.readAt;
  }
}

export class ConversationSummaryResponseDto extends CompactConversationSummaryDto {
  constructor(
    readonly applicationId: string,
    readonly conversationId: string | null,
    readonly openedAt: Date | null,
    hasMessages: boolean,
    capabilities: ConversationCapabilities,
    readonly unreadCount: number,
    readonly lastMessage: ApplicationMessageResponseDto | null,
  ) {
    super(hasMessages, capabilities);
  }
}

export class ConversationDetailResponseDto extends ConversationSummaryResponseDto {
  readonly messages: ApplicationMessageResponseDto[];
  readonly hasMore: boolean;
  readonly nextAfterSequence: number | null;

  constructor(
    summary: ConversationSummaryResponseDto,
    messages: ApplicationMessageResponseDto[],
    hasMore: boolean,
  ) {
    super(
      summary.applicationId,
      summary.conversationId,
      summary.openedAt,
      summary.hasMessages,
      summary,
      summary.unreadCount,
      summary.lastMessage,
    );
    this.messages = messages;
    this.hasMore = hasMore;
    this.nextAfterSequence = hasMore
      ? (messages.at(-1)?.sequence ?? null)
      : null;
  }
}

export class MarkConversationReadResponseDto {
  constructor(readonly markedCount: number) {}
}
