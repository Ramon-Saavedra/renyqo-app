import { randomUUID } from 'node:crypto';
import {
  ApplicationActivityType,
  ApplicationActivityActorType,
  ApplicationActivityVisibility,
} from '../generated/prisma/enums';
import {
  ApplicationOutboxProducer,
  applicationInvalidationType,
} from './application-outbox.producer';
import type { AppendOutboxEventInput } from './outbox-writer.service';
import type { Prisma } from '../generated/prisma/client';

describe('Application outbox producer', () => {
  it('batches listing invalidations with one transaction identity and database deduplication', async () => {
    const listingId = randomUUID();
    const applications = Array.from({ length: 30 }, () => ({
      id: randomUUID(),
    }));
    const createMany = jest.fn().mockResolvedValue({ count: 30 });
    const query = jest.fn().mockResolvedValue([{ id: 321n }]);
    const tx = {
      application: { findMany: jest.fn().mockResolvedValue(applications) },
      outboxEvent: { createMany },
      $queryRaw: query,
    } as unknown as Prisma.TransactionClient;
    const append = jest.fn();
    const producer = new ApplicationOutboxProducer({ append });
    await producer.listing(tx, listingId, new Date());
    expect(query).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: applications.map((app): unknown =>
        expect.objectContaining({
          applicationId: app.id,
          payload: { listingId },
          deduplicationKey: `321:${app.id}:application.lifecycle.changed`,
        }),
      ),
    });
    expect(append).not.toHaveBeenCalled();
  });
  it('covers every viewing activity and lifecycle transition while excluding chat/document history', () => {
    for (const type of Object.values(ApplicationActivityType)) {
      const expected = type.startsWith('VIEWING_')
        ? 'application.viewing.changed'
        : type.startsWith('APPLICATION_')
          ? 'application.lifecycle.changed'
          : null;
      expect(applicationInvalidationType(type)).toBe(expected);
    }
  });
  it('writes only identifiers and coalesces same-transaction intent by stable keys', async () => {
    const listingId = randomUUID(),
      applicationId = randomUUID(),
      workflowId = randomUUID();
    const append = jest
      .fn<
        Promise<{ id: string }>,
        [Prisma.TransactionClient, AppendOutboxEventInput]
      >()
      .mockResolvedValue({ id: randomUUID() });
    const producer = new ApplicationOutboxProducer({
      append,
    });
    const tx = {
      application: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ listingId }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 123n }]),
    } as unknown as Prisma.TransactionClient;
    const input = {
      applicationId,
      type: ApplicationActivityType.VIEWING_ACCEPTED,
      actorType: ApplicationActivityActorType.PROVIDER,
      visibility: ApplicationActivityVisibility.BOTH,
      metadata: {
        workflowId,
        workflowRevision: 3,
        startsAt: 'private-date',
        providerConsideration: 'UNDECIDED' as const,
      },
    };
    await producer.activity(tx, input);
    await producer.activity(tx, {
      ...input,
      type: ApplicationActivityType.VIEWING_RESCHEDULED,
    });
    const first = append.mock.calls[0][1],
      second = append.mock.calls[1][1];
    expect(first).toMatchObject({
      applicationId,
      conversationId: null,
      payload: { listingId, workflowId, workflowRevision: 3 },
    });
    expect(first.deduplicationKey).toBe(second.deduplicationKey);
    expect(Object.keys(first.payload).sort()).toEqual([
      'listingId',
      'workflowId',
      'workflowRevision',
    ]);
    await producer.activity(tx, {
      ...input,
      type: ApplicationActivityType.APPLICATION_REJECTED,
    });
    expect(append.mock.calls[2][1]).toMatchObject({
      type: 'application.lifecycle.changed',
      payload: { listingId },
    });
  });
});
