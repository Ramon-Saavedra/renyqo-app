import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { ConversationSide } from '../generated/prisma/enums';
import {
  ConversationOutboxEventType,
  type ConversationMessageCreatedPayload,
  type ConversationReadAdvancedPayload,
  type ConversationReplyPermissionChangedPayload,
} from './conversation-events';
import { OutboxWriter } from './outbox-writer.service';

@Injectable()
export class ConversationOutboxProducer {
  constructor(private readonly writer: OutboxWriter) {}

  messageCreated(
    tx: Prisma.TransactionClient,
    input: {
      applicationId: string;
      conversationId: string;
      occurredAt: Date;
      messageId: string;
      messageSequence: number;
    },
  ): Promise<{ id: string }> {
    const payload: ConversationMessageCreatedPayload = {
      messageId: input.messageId,
      messageSequence: input.messageSequence,
    };
    return this.writer.append(tx, {
      type: ConversationOutboxEventType.MESSAGE_CREATED,
      applicationId: input.applicationId,
      conversationId: input.conversationId,
      occurredAt: input.occurredAt,
      payload,
    });
  }

  replyPermissionChanged(
    tx: Prisma.TransactionClient,
    input: {
      applicationId: string;
      conversationId: string;
      occurredAt: Date;
      enabled: boolean;
    },
  ): Promise<{ id: string }> {
    const payload: ConversationReplyPermissionChangedPayload = {
      enabled: input.enabled,
    };
    return this.writer.append(tx, {
      type: ConversationOutboxEventType.REPLY_PERMISSION_CHANGED,
      applicationId: input.applicationId,
      conversationId: input.conversationId,
      occurredAt: input.occurredAt,
      payload,
    });
  }

  readAdvanced(
    tx: Prisma.TransactionClient,
    input: {
      applicationId: string;
      conversationId: string;
      occurredAt: Date;
      readerSide: ConversationSide;
      throughSequence: number;
      markedCount: number;
    },
  ): Promise<{ id: string }> {
    const payload: ConversationReadAdvancedPayload = {
      readerSide: input.readerSide,
      throughSequence: input.throughSequence,
      markedCount: input.markedCount,
    };
    return this.writer.append(tx, {
      type: ConversationOutboxEventType.READ_ADVANCED,
      applicationId: input.applicationId,
      conversationId: input.conversationId,
      occurredAt: input.occurredAt,
      payload,
    });
  }
}
