import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { CONVERSATION_OUTBOX_SCHEMA_VERSION } from './conversation-events';

export type AppendOutboxEventInput = {
  readonly type: string;
  readonly applicationId: string;
  readonly conversationId: string;
  readonly occurredAt: Date;
  readonly payload: Prisma.InputJsonValue;
};

@Injectable()
export class OutboxWriter {
  append(
    tx: Prisma.TransactionClient,
    input: AppendOutboxEventInput,
  ): Promise<{ id: string }> {
    return tx.outboxEvent
      .create({
        data: {
          type: input.type,
          schemaVersion: CONVERSATION_OUTBOX_SCHEMA_VERSION,
          applicationId: input.applicationId,
          conversationId: input.conversationId,
          occurredAt: input.occurredAt,
          payload: input.payload,
        },
        select: { id: true },
      })
      .then((row) => ({ id: row.id }));
  }
}
