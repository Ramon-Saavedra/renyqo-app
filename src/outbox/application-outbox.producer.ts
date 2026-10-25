import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ApplicationActivityType as Activity } from '../generated/prisma/enums';
import type {
  AppendApplicationActivityInput,
  ApplicationActivityMetadata,
} from '../applications/application-activity.service';
import { OutboxWriter } from './outbox-writer.service';
import { OUTBOX_SCHEMA_VERSION } from './outbox.types';

const viewing = new Set<Activity>([
  Activity.VIEWING_WORKFLOW_CLOSED,
  Activity.VIEWING_CONSIDERATION_CHANGED,
  Activity.VIEWING_INTEREST_EXPIRED,
  Activity.VIEWING_REPLACEMENT_PROPOSED,
  Activity.VIEWING_PROPOSAL_WITHDRAWN,
  Activity.VIEWING_PROPOSAL_EXPIRED,
  Activity.VIEWING_PROPOSED,
  Activity.VIEWING_ACCEPTED,
  Activity.VIEWING_DECLINED,
  Activity.VIEWING_CHANGE_REQUESTED,
  Activity.VIEWING_RESCHEDULED,
  Activity.VIEWING_CANCELLED,
  Activity.VIEWING_COMPLETED,
  Activity.VIEWING_NO_SHOW,
  Activity.VIEWING_OUTCOME_CORRECTED,
  Activity.VIEWING_INTEREST_CONFIRMED,
  Activity.VIEWING_INTEREST_DECLINED,
]);
const lifecycle = new Set<Activity>([
  Activity.APPLICATION_SUBMITTED,
  Activity.APPLICATION_PROMOTED_TO_ACTIVE,
  Activity.APPLICATION_WITHDRAWN,
  Activity.APPLICATION_REJECTED,
  Activity.APPLICATION_RESTORED,
  Activity.APPLICATION_ACCEPTED,
]);
export const applicationInvalidationType = (type: Activity) =>
  viewing.has(type)
    ? ('application.viewing.changed' as const)
    : lifecycle.has(type)
      ? ('application.lifecycle.changed' as const)
      : null;

@Injectable()
export class ApplicationOutboxProducer {
  constructor(private readonly writer: OutboxWriter) {}
  async activity(
    tx: Prisma.TransactionClient,
    input: AppendApplicationActivityInput,
  ) {
    const type = applicationInvalidationType(input.type);
    if (type)
      await this.emit(
        tx,
        input.applicationId,
        type,
        input.occurredAt ?? new Date(),
        input.metadata,
      );
  }
  viewing(
    tx: Prisma.TransactionClient,
    applicationId: string,
    occurredAt: Date,
    metadata: ApplicationActivityMetadata,
  ) {
    return this.emit(
      tx,
      applicationId,
      'application.viewing.changed',
      occurredAt,
      metadata,
    );
  }
  async listing(
    tx: Prisma.TransactionClient,
    listingId: string,
    occurredAt: Date,
  ) {
    const applications = await tx.application.findMany({
      where: { listingId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!applications.length) return;
    const [{ id }] = await tx.$queryRaw<
      { id: bigint }[]
    >`SELECT txid_current() AS id`;
    // Keep application scope for delivery-time authorization. Existing activity
    // producers may already have written the same transaction's invalidation.
    await tx.outboxEvent.createMany({
      data: applications.map((app) => ({
        type: 'application.lifecycle.changed',
        schemaVersion: OUTBOX_SCHEMA_VERSION,
        applicationId: app.id,
        conversationId: null,
        occurredAt,
        payload: { listingId },
        deduplicationKey: `${id}:${app.id}:application.lifecycle.changed`,
      })),
      skipDuplicates: true,
    });
  }
  private async emit(
    tx: Prisma.TransactionClient,
    applicationId: string,
    type: 'application.viewing.changed' | 'application.lifecycle.changed',
    occurredAt: Date,
    metadata?: ApplicationActivityMetadata,
    knownListingId?: string,
  ) {
    const listingId =
      knownListingId ??
      (
        await tx.application.findUniqueOrThrow({
          where: { id: applicationId },
          select: { listingId: true },
        })
      ).listingId;
    const [{ id }] = await tx.$queryRaw<
      { id: bigint }[]
    >`SELECT txid_current() AS id`;
    const payload: Prisma.InputJsonObject = {
      listingId,
      ...(type === 'application.viewing.changed' && metadata?.workflowId
        ? {
            workflowId: metadata.workflowId,
            ...(metadata.workflowRevision !== undefined
              ? { workflowRevision: metadata.workflowRevision }
              : {}),
          }
        : {}),
    };
    await this.writer.append(tx, {
      type,
      applicationId,
      conversationId: null,
      occurredAt,
      payload,
      deduplicationKey: `${id}:${applicationId}:${type}`,
    });
  }
}
