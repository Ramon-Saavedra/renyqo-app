import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ClaimedOutboxEvent } from './outbox.types';

type ClaimedRow = {
  id: string;
  type: string;
  schema_version: number;
  application_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
  payload: unknown;
  occurred_at: Date;
  attempt_count: number;
  claim_token: string;
};

@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  claimBatch(
    claimToken: string,
    asOf: Date,
    leaseUntil: Date,
    batchSize: number,
  ): Promise<ClaimedOutboxEvent[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH candidates AS (
          SELECT id
          FROM outbox_events
          WHERE dispatched_at IS NULL
            AND next_attempt_at <= ${asOf}
            AND (claimed_until IS NULL OR claimed_until < ${asOf})
          ORDER BY created_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events AS e
        SET claim_token = ${claimToken}::uuid,
            claimed_until = ${leaseUntil},
            attempt_count = e.attempt_count + 1
        FROM candidates AS c
        WHERE e.id = c.id
        RETURNING
          e.id,
          e.type,
          e.schema_version,
          e.application_id,
          e.user_id,
          e.conversation_id,
          e.payload,
          e.occurred_at,
          e.attempt_count,
          e.claim_token
      `);
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        schemaVersion: row.schema_version,
        applicationId: row.application_id,
        userId: row.user_id,
        conversationId: row.conversation_id,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attemptCount: row.attempt_count,
        claimToken: row.claim_token,
      }));
    });
  }

  markDispatched(
    eventId: string,
    claimToken: string,
    dispatchedAt: Date,
  ): Promise<number> {
    return this.prisma.outboxEvent
      .updateMany({
        where: { id: eventId, claimToken, dispatchedAt: null },
        data: {
          dispatchedAt,
          claimToken: null,
          claimedUntil: null,
          lastError: null,
        },
      })
      .then((result) => result.count);
  }

  releaseAfterFailure(
    eventId: string,
    claimToken: string,
    nextAttemptAt: Date,
    lastError: string,
    exhausted: boolean,
  ): Promise<number> {
    return this.prisma.outboxEvent
      .updateMany({
        where: { id: eventId, claimToken, dispatchedAt: null },
        data: {
          claimToken: null,
          claimedUntil: null,
          nextAttemptAt: exhausted
            ? new Date('2099-01-01T00:00:00.000Z')
            : nextAttemptAt,
          lastError: lastError.slice(0, 500),
        },
      })
      .then((result) => result.count);
  }

  deleteDispatchedOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM outbox_events
      WHERE id IN (
        SELECT id
        FROM outbox_events
        WHERE dispatched_at IS NOT NULL
          AND dispatched_at < ${cutoff}
        ORDER BY dispatched_at ASC
        LIMIT ${batchSize}
      )
    `);
  }
}
