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
});
