export const OUTBOX_SCHEMA_VERSION = 1;
export type ClaimedOutboxEvent = {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly applicationId: string | null;
  readonly userId?: string | null;
  readonly conversationId: string | null;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly attemptCount: number;
  readonly claimToken: string;
};
