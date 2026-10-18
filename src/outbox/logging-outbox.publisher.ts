import { Injectable, Logger } from '@nestjs/common';
import type { OutboxPublishEvent, OutboxPublisher } from './outbox-publisher';

@Injectable()
export class LoggingOutboxPublisher implements OutboxPublisher {
  private readonly logger = new Logger(LoggingOutboxPublisher.name);

  publish(event: OutboxPublishEvent): Promise<void> {
    this.logger.log({
      signal: 'OUTBOX_EVENT_PUBLISHED',
      eventId: event.eventId,
      type: event.type,
      schemaVersion: event.schemaVersion,
      applicationId: event.applicationId,
      conversationId: event.conversationId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    });
    return Promise.resolve();
  }
}
