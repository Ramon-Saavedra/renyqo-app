import { OutboxWriter } from './outbox-writer.service';
import { ConversationOutboxEventType } from './conversation-events';

describe('OutboxWriter', () => {
  const writer = new OutboxWriter();

  it('appends through the supplied transaction client only', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-id' });
    const tx = { outboxEvent: { create } };
    const occurredAt = new Date('2027-01-01T10:00:00.000Z');

    await expect(
      writer.append(tx as never, {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        applicationId: 'app',
        conversationId: 'conv',
        occurredAt,
        payload: { messageId: 'm', messageSequence: 1 },
      }),
    ).resolves.toEqual({ id: 'event-id' });

    expect(create).toHaveBeenCalledWith({
      data: {
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        schemaVersion: 1,
        applicationId: 'app',
        conversationId: 'conv',
        occurredAt,
        payload: { messageId: 'm', messageSequence: 1 },
      },
      select: { id: true },
    });
  });
});
