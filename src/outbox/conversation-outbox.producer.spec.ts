import { ConversationSide } from '../generated/prisma/enums';
import { ConversationOutboxEventType } from './conversation-events';
import { ConversationOutboxProducer } from './conversation-outbox.producer';
import { OutboxWriter } from './outbox-writer.service';

describe('ConversationOutboxProducer', () => {
  it('does not include message bodies in payloads', async () => {
    const append = jest
      .fn()
      .mockResolvedValue({ id: 'event' }) as OutboxWriter['append'];
    const producer = new ConversationOutboxProducer({ append });
    const occurredAt = new Date();

    await producer.messageCreated({} as never, {
      applicationId: 'app',
      conversationId: 'conv',
      occurredAt,
      messageId: 'message',
      messageSequence: 2,
    });

    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: ConversationOutboxEventType.MESSAGE_CREATED,
        payload: { messageId: 'message', messageSequence: 2 },
      }),
    );
  });

  it('serializes read advancement metadata', async () => {
    const append = jest
      .fn()
      .mockResolvedValue({ id: 'event' }) as OutboxWriter['append'];
    const producer = new ConversationOutboxProducer({ append });

    await producer.readAdvanced({} as never, {
      applicationId: 'app',
      conversationId: 'conv',
      occurredAt: new Date(),
      readerSide: ConversationSide.APPLICANT,
      throughSequence: 3,
      markedCount: 2,
    });

    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: {
          readerSide: ConversationSide.APPLICANT,
          throughSequence: 3,
          markedCount: 2,
        },
      }),
    );
  });
});
