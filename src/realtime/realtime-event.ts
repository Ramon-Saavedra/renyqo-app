import { ConversationSide } from '../generated/prisma/enums';
import type { OutboxPublishEvent } from '../outbox/outbox-publisher';

type Payloads = {
  'conversation.message.created': {
    messageId: string;
    messageSequence: number;
  };
  'conversation.reply-permission.changed': { enabled: boolean };
  'conversation.read.advanced': {
    readerSide: ConversationSide;
    throughSequence: number;
    markedCount: number;
  };
};
export type RealtimeEvent = {
  [K in keyof Payloads]: {
    eventId: string;
    type: K;
    schemaVersion: 1;
    occurredAt: string;
    applicationId: string;
    conversationId: string;
    payload: Payloads[K];
  };
}[keyof Payloads];

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  );
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function realtimeEvent(event: OutboxPublishEvent): RealtimeEvent {
  if (
    event.schemaVersion !== 1 ||
    !uuid(event.eventId) ||
    !uuid(event.applicationId) ||
    !uuid(event.conversationId) ||
    !(event.occurredAt instanceof Date) ||
    !Number.isFinite(event.occurredAt.getTime())
  )
    throw new Error('Unsupported realtime event envelope');
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid realtime payload');
  const base = {
    eventId: event.eventId,
    schemaVersion: 1 as const,
    occurredAt: event.occurredAt.toISOString(),
    applicationId: event.applicationId,
    conversationId: event.conversationId,
  };
  switch (event.type) {
    case 'conversation.message.created':
      if (
        'messageId' in payload &&
        uuid(payload.messageId) &&
        'messageSequence' in payload &&
        positive(payload.messageSequence)
      )
        return {
          ...base,
          type: event.type,
          payload: {
            messageId: payload.messageId,
            messageSequence: payload.messageSequence,
          },
        };
      break;
    case 'conversation.reply-permission.changed':
      if ('enabled' in payload && typeof payload.enabled === 'boolean')
        return {
          ...base,
          type: event.type,
          payload: { enabled: payload.enabled },
        };
      break;
    case 'conversation.read.advanced':
      if (
        'readerSide' in payload &&
        (payload.readerSide === ConversationSide.PROVIDER ||
          payload.readerSide === ConversationSide.APPLICANT) &&
        'throughSequence' in payload &&
        positive(payload.throughSequence) &&
        'markedCount' in payload &&
        positive(payload.markedCount)
      )
        return {
          ...base,
          type: event.type,
          payload: {
            readerSide: payload.readerSide,
            throughSequence: payload.throughSequence,
            markedCount: payload.markedCount,
          },
        };
  }
  throw new Error('Unsupported realtime event type or payload');
}
