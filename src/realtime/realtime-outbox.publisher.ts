import { Injectable } from '@nestjs/common';
import type {
  OutboxPublisher,
  OutboxPublishEvent,
} from '../outbox/outbox-publisher';
import { RealtimeEventRouter } from './realtime-event-router.service';
import { RealtimeDeliveryService } from './realtime-delivery.service';
import { realtimeEvent } from './realtime-event';
import { withRealtimeDeadline } from './realtime-deadline';

@Injectable()
export class RealtimeOutboxPublisher implements OutboxPublisher {
  constructor(
    private readonly router: RealtimeEventRouter,
    private readonly delivery: RealtimeDeliveryService,
  ) {}
  async publish(input: OutboxPublishEvent): Promise<void> {
    this.delivery.assertReady();
    const event = realtimeEvent(input);
    try {
      await withRealtimeDeadline(async (signal) => {
        const recipients = await this.router.recipients(event);
        if (signal.aborted) throw new Error('Realtime publication cancelled');
        await this.delivery.publish(event, recipients, signal);
      });
    } catch {
      // Dispatcher persists/logs this message. Never propagate database/session details.
      throw new Error('Realtime routing or delivery unavailable');
    }
  }
}
