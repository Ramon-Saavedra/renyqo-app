import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { RealtimeEventRouter } from './realtime-event-router.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeConnectionsService } from './realtime-connections.service';
import { RealtimeDeliveryService } from './realtime-delivery.service';
import type { RealtimeEvent } from './realtime-event';

describe('Realtime delivery lifecycle', () => {
  let delivery: RealtimeDeliveryService;
  type RealtimeSocketMock = {
    connected: boolean;
    emit: ReturnType<typeof jest.fn>;
  };
  type EligibleConnection = {
    socket: RealtimeSocketMock;
    identity: { userId: string };
  };
  const eligible = jest.fn<() => Promise<EligibleConnection[]>>();
  const recipients = jest.fn<() => Promise<string[]>>();
  const isStopped = jest.fn<() => boolean>();
  const event: RealtimeEvent = {
    eventId: 'id',
    type: 'conversation.reply-permission.changed',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    applicationId: 'application',
    conversationId: 'conversation',
    payload: { enabled: true },
  };

  beforeEach(async () => {
    eligible.mockReset().mockResolvedValue([]);
    recipients.mockReset().mockResolvedValue([]);
    isStopped.mockReset().mockReturnValue(false);
    const module = await Test.createTestingModule({
      providers: [
        RealtimeDeliveryService,
        { provide: RealtimeConfigService, useValue: { enabled: false } },
        {
          provide: RealtimeConnectionsService,
          useValue: { eligible, isStopped },
        },
        {
          provide: RealtimeEventRouter,
          useValue: {
            routes: async () =>
              (await recipients()).map((userId) => ({ userId, event })),
          },
        },
      ],
    }).compile();
    delivery = module.get(RealtimeDeliveryService);
  });

  it('rejects before initialization and after shutdown', async () => {
    const signal = new AbortController().signal;
    await expect(delivery.publish(event, [], signal)).rejects.toThrow(
      'unavailable',
    );
    delivery.start();
    await expect(delivery.publish(event, [], signal)).resolves.toBeUndefined();
    delivery.onModuleDestroy();
    await expect(delivery.publish(event, [], signal)).rejects.toThrow(
      'unavailable',
    );
  });

  it('rejects an aborted publish after session lookup', async () => {
    delivery.start();
    const controller = new AbortController();
    eligible.mockImplementation(() => {
      controller.abort();
      return Promise.resolve([]);
    });
    await expect(
      delivery.publish(event, [], controller.signal),
    ).rejects.toThrow('cancelled');
  });

  it('revalidates recipients before emit and skips users no longer authorized', async () => {
    delivery.start();
    const emit = jest.fn();
    eligible.mockResolvedValue([
      {
        socket: { connected: true, emit },
        identity: { userId: 'provider' },
      },
    ]);
    recipients.mockResolvedValue([]);
    const signal = new AbortController().signal;
    await delivery.publish(event, ['provider'], signal);
    expect(recipients).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails instead of acknowledging when the transport is stopping', async () => {
    delivery.start();
    isStopped.mockReturnValue(true);
    const signal = new AbortController().signal;
    await expect(delivery.publish(event, ['user'], signal)).rejects.toThrow(
      'unavailable',
    );
    expect(recipients).not.toHaveBeenCalled();
  });
});
