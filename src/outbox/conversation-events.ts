import type { ConversationSide } from '../generated/prisma/enums';

export const CONVERSATION_OUTBOX_SCHEMA_VERSION = 1;

export const ConversationOutboxEventType = {
  MESSAGE_CREATED: 'conversation.message.created',
  REPLY_PERMISSION_CHANGED: 'conversation.reply-permission.changed',
  READ_ADVANCED: 'conversation.read.advanced',
} as const;

export type ConversationOutboxEventType =
  (typeof ConversationOutboxEventType)[keyof typeof ConversationOutboxEventType];

export type ConversationMessageCreatedPayload = {
  readonly messageId: string;
  readonly messageSequence: number;
};

export type ConversationReplyPermissionChangedPayload = {
  readonly enabled: boolean;
};

export type ConversationReadAdvancedPayload = {
  readonly readerSide: ConversationSide;
  readonly throughSequence: number;
  readonly markedCount: number;
};

export type ConversationOutboxPayload =
  | ConversationMessageCreatedPayload
  | ConversationReplyPermissionChangedPayload
  | ConversationReadAdvancedPayload;

export type ConversationOutboxEnvelope = {
  readonly applicationId: string;
  readonly conversationId: string;
  readonly type: ConversationOutboxEventType;
  readonly occurredAt: Date;
  readonly payload: ConversationOutboxPayload;
};
