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
export type ConversationRealtimeEvent = {
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

export type ApplicationRealtimeEvent = {
  eventId: string;
  type: 'application.viewing.changed' | 'application.lifecycle.changed';
  schemaVersion: 1;
  occurredAt: string;
  applicationId: string;
  payload: {
    listingId: string;
    workflowId?: string;
    workflowRevision?: number;
  };
};
export type ListingApplicationInvalidation = {
  eventId: string;
  type: 'listing.applications.changed';
  schemaVersion: 1;
  occurredAt: string;
  listingId: string;
  payload: Record<string, never>;
};
export type NotificationRealtimeEvent = {
  eventId: string;
  type: 'notifications.changed';
  schemaVersion: 1;
  occurredAt: string;
  userId: string;
  payload: Record<string, never>;
};
export type RealtimeEvent =
  | NotificationRealtimeEvent
  | ConversationRealtimeEvent
  | ApplicationRealtimeEvent
  | ListingApplicationInvalidation;
export function isApplicationEvent(
  event: RealtimeEvent,
): event is ApplicationRealtimeEvent {
  return (
    event.type === 'application.viewing.changed' ||
    event.type === 'application.lifecycle.changed'
  );
}
export function listingInvalidation(
  event: ApplicationRealtimeEvent,
  listingId: string,
): ListingApplicationInvalidation {
  if (!uuid(listingId)) throw new Error('Invalid listing invalidation target');
  return {
    eventId: event.eventId,
    type: 'listing.applications.changed',
    schemaVersion: 1,
    occurredAt: event.occurredAt,
    listingId,
    payload: {},
  };
}

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
    !(event.occurredAt instanceof Date) ||
    !Number.isFinite(event.occurredAt.getTime())
  )
    throw new Error('Unsupported realtime event envelope');
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid realtime payload');
  if (event.type === 'notifications.changed') {
    if (
      event.applicationId !== null ||
      event.conversationId !== null ||
      !uuid(event.userId) ||
      Object.keys(payload).length
    )
      throw new Error('Invalid notification invalidation scope');
    return {
      eventId: event.eventId,
      type: event.type,
      schemaVersion: 1,
      occurredAt: event.occurredAt.toISOString(),
      userId: event.userId,
      payload: {},
    };
  }
  if (!uuid(event.applicationId) || event.userId != null)
    throw new Error('Invalid application scope');
  if (
    event.type === 'application.viewing.changed' ||
    event.type === 'application.lifecycle.changed'
  ) {
    if (
      event.conversationId !== null ||
      !('listingId' in payload) ||
      !uuid(payload.listingId)
    )
      throw new Error('Invalid application event scope');
    const keys =
      event.type === 'application.viewing.changed'
        ? ['listingId', 'workflowId', 'workflowRevision']
        : ['listingId'];
    if (Object.keys(payload).some((k) => !keys.includes(k)))
      throw new Error('Unsupported application invalidation payload');
    if ('workflowId' in payload && !uuid(payload.workflowId))
      throw new Error('Invalid workflow identifier');
    if (
      'workflowRevision' in payload &&
      (typeof payload.workflowRevision !== 'number' ||
        !Number.isSafeInteger(payload.workflowRevision) ||
        payload.workflowRevision < 0 ||
        !('workflowId' in payload))
    )
      throw new Error('Invalid workflow revision');
    return {
      eventId: event.eventId,
      type: event.type,
      schemaVersion: 1,
      occurredAt: event.occurredAt.toISOString(),
      applicationId: event.applicationId,
      payload: {
        listingId: payload.listingId,
        ...('workflowId' in payload
          ? { workflowId: payload.workflowId as string }
          : {}),
        ...('workflowRevision' in payload
          ? { workflowRevision: payload.workflowRevision as number }
          : {}),
      },
    };
  }
  if (!uuid(event.conversationId))
    throw new Error('Invalid conversation event scope');
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
