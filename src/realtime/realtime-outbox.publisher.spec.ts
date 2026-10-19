import { randomUUID } from 'node:crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConversationEventRouter } from './conversation-event-router.service';
import { RealtimeDeliveryService } from './realtime-delivery.service';
import { RealtimeOutboxPublisher } from './realtime-outbox.publisher';
import { REALTIME_OPERATION_TIMEOUT_MS } from './realtime-deadline';

describe('Realtime publisher failures', () => {
  const input = {
    eventId: randomUUID(),
    type: 'conversation.reply-permission.changed',
    schemaVersion: 1,
    applicationId: randomUUID(),
    conversationId: randomUUID(),
    occurredAt: new Date(),
    payload: { enabled: true },
  };
  const recipients = jest.fn<() => Promise<string[]>>();
  const publish = jest.fn<() => Promise<void>>();
  let publisher: RealtimeOutboxPublisher;
  beforeEach(async () => {
    recipients.mockReset().mockResolvedValue(['user']);
    publish.mockReset().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        RealtimeOutboxPublisher,
        { provide: ConversationEventRouter, useValue: { recipients } },
        {
          provide: RealtimeDeliveryService,
          useValue: { assertReady: () => undefined, publish },
        },
      ],
    }).compile();
    publisher = module.get(RealtimeOutboxPublisher);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('propagates a safe retryable error when routing fails', async () => {
    recipients.mockRejectedValue(
      new Error('database secret must not be logged'),
    );
    await expect(publisher.publish(input)).rejects.toThrow(
      'Realtime routing or delivery unavailable',
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it('propagates delivery failure for outbox retry', async () => {
    publish.mockRejectedValue(new Error('session lookup failure'));
    await expect(publisher.publish(input)).rejects.toThrow('unavailable');
  });
  it('does not publish if a routing lookup completes after the deadline', async () => {
    jest.useFakeTimers();
    let complete: (users: string[]) => void = () => {
      throw new Error('Lookup not started');
    };
    recipients.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const result = expect(publisher.publish(input)).rejects.toThrow(
      'unavailable',
    );
    await jest.advanceTimersByTimeAsync(REALTIME_OPERATION_TIMEOUT_MS);
    await result;
    complete(['user']);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
});
