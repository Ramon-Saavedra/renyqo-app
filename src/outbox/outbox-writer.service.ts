import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { OUTBOX_SCHEMA_VERSION } from './outbox.types';

export type AppendOutboxEventInput = {
  readonly type: string;
  readonly applicationId: string | null;
  readonly userId?: string;
  readonly conversationId: string | null;
  readonly deduplicationKey?: string;
  readonly occurredAt: Date;
  readonly payload: Prisma.InputJsonValue;
};

@Injectable()
export class OutboxWriter {
  append(
    tx: Prisma.TransactionClient,
    input: AppendOutboxEventInput,
  ): Promise<{ id: string }> {
    if (input.deduplicationKey)
      return tx.outboxEvent.upsert({
        where: { deduplicationKey: input.deduplicationKey },
        create: {
          type: input.type,
          schemaVersion: OUTBOX_SCHEMA_VERSION,
          applicationId: input.applicationId,
          userId: input.userId,
          conversationId: input.conversationId,
          payload: input.payload,
          occurredAt: input.occurredAt,
          deduplicationKey: input.deduplicationKey,
        },
        update: { payload: input.payload, occurredAt: input.occurredAt },
        select: { id: true },
      });
    return tx.outboxEvent
      .create({
        data: {
          type: input.type,
          schemaVersion: OUTBOX_SCHEMA_VERSION,
          applicationId: input.applicationId,
          userId: input.userId,
          conversationId: input.conversationId,
          occurredAt: input.occurredAt,
          payload: input.payload,
        },
        select: { id: true },
      })
      .then((row) => ({ id: row.id }));
  }
}
