export type OutboxPublishEvent = {
  readonly eventId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly applicationId: string;
  readonly conversationId: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
};

export interface OutboxPublisher {
  publish(event: OutboxPublishEvent): Promise<void>;
}

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');
