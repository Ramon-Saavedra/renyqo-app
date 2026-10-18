export type ClaimedOutboxEvent = {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly applicationId: string;
  readonly conversationId: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly attemptCount: number;
  readonly claimToken: string;
};
