import { randomUUID } from 'node:crypto';
import {
  ApplicationStatus,
  ListingStatus,
  Role,
  UserStatus,
} from '../src/generated/prisma/enums';
import { RealtimeOutboxPublisher } from '../src/realtime/realtime-outbox.publisher';
import { RealtimeDeliveryService } from '../src/realtime/realtime-delivery.service';
import type { OutboxPublishEvent } from '../src/outbox/outbox-publisher';
import { connected, quietPeriod, realtimeTestApp } from './realtime-test-app';

describe('Realtime conversation delivery', () => {
  let context: Awaited<ReturnType<typeof realtimeTestApp>>;
  let publisher: RealtimeOutboxPublisher;
  beforeAll(async () => {
    context = await realtimeTestApp();
    publisher = context.app.get(RealtimeOutboxPublisher);
  });
  afterAll(async () => {
    await context?.close();
  });

  async function fixture() {
    const provider = await context.user(Role.PROVIDER);
    const applicant = await context.user();
    const listing = await context.prisma.listing.create({
      data: {
        providerId: provider.userId,
        displayOrder: 1,
        status: ListingStatus.PUBLISHED,
      },
    });
    const application = await context.prisma.application.create({
      data: {
        applicantId: applicant.userId,
        listingId: listing.id,
        status: ApplicationStatus.ACTIVE,
        activeAt: new Date(),
      },
    });
    const conversation = await context.prisma.applicationConversation.create({
      data: { applicationId: application.id },
    });
    const messageId = randomUUID();
    const event: OutboxPublishEvent = {
      eventId: randomUUID(),
      type: 'conversation.message.created',
      schemaVersion: 1,
      applicationId: application.id,
      conversationId: conversation.id,
      occurredAt: new Date(),
      payload: {
        messageId,
        messageSequence: 1,
        body: 'must never escape',
      },
    };
    return { provider, applicant, event, messageId };
  }

  it('delivers allowlisted metadata to owners only; duplicates preserve eventId', async () => {
    const { provider, applicant, event, messageId } = await fixture();
    const foreign = await context.user(Role.PROVIDER);
    const providerSocket = context.client(provider.cookie);
    const applicantSocket = context.client(applicant.cookie, undefined, {
      userId: foreign.userId,
      role: 'PROVIDER',
    });
    const foreignSocket = context.client(foreign.cookie);
    const providerEvents: unknown[] = [],
      applicantEvents: unknown[] = [],
      foreignEvents: unknown[] = [];
    providerSocket.on('domain-event', (value: unknown) =>
      providerEvents.push(value),
    );
    applicantSocket.on('domain-event', (value: unknown) =>
      applicantEvents.push(value),
    );
    foreignSocket.on('domain-event', (value: unknown) =>
      foreignEvents.push(value),
    );
    await Promise.all([
      connected(providerSocket),
      connected(applicantSocket),
      connected(foreignSocket),
    ]);
    await publisher.publish(event);
    await publisher.publish(event);
    await quietPeriod();
    const expected = {
      eventId: event.eventId,
      type: event.type,
      schemaVersion: 1,
      occurredAt: event.occurredAt.toISOString(),
      applicationId: event.applicationId,
      conversationId: event.conversationId,
      payload: {
        messageId,
        messageSequence: 1,
      },
    };
    expect(providerEvents).toEqual([expected, expected]);
    expect(applicantEvents).toEqual([expected, expected]);
    expect(foreignEvents).toEqual([]);
    for (const socket of [providerSocket, applicantSocket, foreignSocket])
      socket.disconnect();
  });

  it('does not leak delayed events to a provider after WAITING restoration', async () => {
    const { provider, applicant, event } = await fixture();
    const providerSocket = context.client(provider.cookie),
      applicantSocket = context.client(applicant.cookie);
    const hidden: unknown[] = [],
      own: unknown[] = [];
    providerSocket.on('domain-event', (value: unknown) => hidden.push(value));
    applicantSocket.on('domain-event', (value: unknown) => own.push(value));
    await Promise.all([connected(providerSocket), connected(applicantSocket)]);
    await context.prisma.application.update({
      where: { id: event.applicationId! },
      data: { status: ApplicationStatus.WAITING, activeAt: null },
    });
    await publisher.publish(event);
    await quietPeriod();
    expect(hidden).toEqual([]);
    expect(own).toHaveLength(1);
    providerSocket.disconnect();
    applicantSocket.disconnect();
  });

  it('does not deliver to a deleted account on pre-delivery validation', async () => {
    const { applicant, event } = await fixture();
    const socket = context.client(applicant.cookie);
    const received: unknown[] = [];
    socket.on('domain-event', (value: unknown) => received.push(value));
    await connected(socket);
    await context.prisma.user.update({
      where: { id: applicant.userId },
      data: { status: UserStatus.DELETED },
    });
    await publisher.publish(event);
    await quietPeriod();
    expect(received).toEqual([]);
    socket.disconnect();
  });

  it('excludes an invalid session while another session for that user remains connected', async () => {
    const { applicant, event } = await fixture();
    const other = await context.sessionFor(applicant.userId);
    const invalid = context.client(applicant.cookie),
      valid = context.client(other.cookie);
    const forbidden: unknown[] = [],
      received: unknown[] = [];
    invalid.on('domain-event', (value: unknown) => forbidden.push(value));
    valid.on('domain-event', (value: unknown) => received.push(value));
    await Promise.all([connected(invalid), connected(valid)]);
    await context.prisma.userSession.delete({ where: { sid: applicant.id } });
    await publisher.publish(event);
    await quietPeriod();
    expect(forbidden).toEqual([]);
    expect(received).toHaveLength(1);
    invalid.disconnect();
    valid.disconnect();
  });

  it.each([
    {
      type: 'conversation.reply-permission.changed',
      payload: { enabled: false },
    },
    {
      type: 'conversation.read.advanced',
      payload: { readerSide: 'APPLICANT', throughSequence: 3, markedCount: 2 },
    },
  ])(
    'delivers $type without inventing another event type',
    async ({ type, payload }) => {
      const { applicant, event } = await fixture();
      const socket = context.client(applicant.cookie);
      await connected(socket);
      const received = new Promise<unknown>((resolve) =>
        socket.once('domain-event', resolve),
      );
      await publisher.publish({ ...event, type, payload });
      expect(await received).toEqual(
        expect.objectContaining({ type, payload }),
      );
      socket.disconnect();
    },
  );

  it('completes when recipients are offline and rejects unavailable transport', async () => {
    const { event } = await fixture();
    await expect(publisher.publish(event)).resolves.toBeUndefined();
    const delivery = context.app.get(RealtimeDeliveryService);
    delivery.onModuleDestroy();
    await expect(publisher.publish(event)).rejects.toThrow('unavailable');
    delivery.start();
  });

  it('fails closed on cross-application conversation IDs', async () => {
    const { event } = await fixture();
    const second = await fixture();
    const socket = context.client(second.applicant.cookie);
    const received: unknown[] = [];
    socket.on('domain-event', (value: unknown) => received.push(value));
    await connected(socket);
    await publisher.publish({
      ...event,
      conversationId: second.event.conversationId,
    });
    await quietPeriod();
    expect(received).toEqual([]);
    socket.disconnect();
  });
});
