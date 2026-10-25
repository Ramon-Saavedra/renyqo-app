import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { OutboxPublishEvent } from '../outbox/outbox-publisher';
import { realtimeEvent } from './realtime-event';

describe('Realtime wire boundary', () => {
  const base: OutboxPublishEvent = {
    eventId: randomUUID(),
    type: 'conversation.message.created',
    schemaVersion: 1,
    applicationId: randomUUID(),
    conversationId: randomUUID(),
    occurredAt: new Date(),
    payload: { messageId: randomUUID(), messageSequence: 1, body: 'private' },
  };
  it('drops extra fields and serializes the timestamp', () => {
    const output = realtimeEvent(base);
    expect(Object.keys(output).sort()).toEqual(
      [
        'eventId',
        'type',
        'schemaVersion',
        'occurredAt',
        'applicationId',
        'conversationId',
        'payload',
      ].sort(),
    );
    expect(output.occurredAt).toBe(base.occurredAt.toISOString());
    expect(output.payload).not.toHaveProperty('body');
  });
  it('strictly validates user-only notification hints without exposing an application', () => {
    const event = {
      ...base,
      type: 'notifications.changed',
      applicationId: null,
      conversationId: null,
      userId: randomUUID(),
      payload: {},
    };
    expect(realtimeEvent(event)).toEqual({
      eventId: event.eventId,
      type: event.type,
      schemaVersion: 1,
      occurredAt: event.occurredAt.toISOString(),
      userId: event.userId,
      payload: {},
    });
    for (const patch of [
      { userId: null },
      { applicationId: randomUUID() },
      { conversationId: randomUUID() },
      { payload: { unreadCount: 1 } },
      { payload: { notificationId: randomUUID() } },
    ])
      expect(() => realtimeEvent({ ...event, ...patch })).toThrow();
    expect(() => realtimeEvent({ ...base, userId: randomUUID() })).toThrow();
  });
  it.each([
    { schemaVersion: 2 },
    { type: 'join' },
    { applicationId: 'invalid' },
    { occurredAt: new Date(NaN) },
    { payload: null },
    { payload: { messageId: randomUUID(), messageSequence: -1 } },
    {
      type: 'conversation.reply-permission.changed',
      payload: { enabled: 'true' },
    },
    {
      type: 'conversation.read.advanced',
      payload: { readerSide: 'ADMIN', throughSequence: 1, markedCount: 1 },
    },
  ])('rejects unsupported or malformed events: %j', (patch) => {
    expect(() => realtimeEvent({ ...base, ...patch })).toThrow();
  });
  it('accepts application invalidations without a conversation and rejects sensitive/state copies', () => {
    const application = {
      ...base,
      type: 'application.viewing.changed',
      conversationId: null,
      payload: {
        listingId: randomUUID(),
        workflowId: randomUUID(),
        workflowRevision: 0,
      },
    };
    const output = realtimeEvent(application);
    expect(output).not.toHaveProperty('conversationId');
    expect(output.payload).toEqual(application.payload);
    for (const extra of [
      { message: 'private' },
      { status: 'ACTIVE' },
      { count: 2 },
      { applicantId: randomUUID() },
      { startsAt: new Date().toISOString() },
    ])
      expect(() =>
        realtimeEvent({
          ...application,
          payload: { ...application.payload, ...extra },
        }),
      ).toThrow();
    expect(() =>
      realtimeEvent({ ...application, conversationId: randomUUID() }),
    ).toThrow();
    expect(() =>
      realtimeEvent({
        ...application,
        payload: { listingId: randomUUID(), workflowRevision: 2 },
      }),
    ).toThrow();
    expect(() =>
      realtimeEvent({
        ...application,
        payload: {
          listingId: randomUUID(),
          workflowId: randomUUID(),
          workflowRevision: -1,
        },
      }),
    ).toThrow();
    expect(() =>
      realtimeEvent({ ...application, type: 'application.lifecycle.changed' }),
    ).toThrow();
    expect(
      realtimeEvent({
        ...application,
        type: 'application.lifecycle.changed',
        payload: { listingId: randomUUID() },
      }),
    ).toMatchObject({ type: 'application.lifecycle.changed' });
    expect(() => realtimeEvent({ ...base, conversationId: null })).toThrow();
  });
});
