export type OutboxPublishEvent = {
  readonly eventId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly applicationId: string | null;
  readonly userId?: string | null;
  readonly conversationId: string | null;
  readonly occurredAt: Date;
  readonly payload: unknown;
};

export interface OutboxPublisher {
  publish(event: OutboxPublishEvent): Promise<void>;
}

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');
