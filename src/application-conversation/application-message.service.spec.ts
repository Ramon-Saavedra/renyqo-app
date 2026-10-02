import { ApplicationMessageService } from './application-message.service';
import { ConversationSide } from '../generated/prisma/enums';

describe('ApplicationMessageService', () => {
  const service = new ApplicationMessageService();

  it('normalizes plain text without interpreting encoded markup', () => {
    expect(service.validateBody('  Grüße &lt;b&gt;\nhello  ')).toBe(
      'Grüße &lt;b&gt;\nhello',
    );
  });

  it.each(['', '\n\t ', '<script>alert(1)</script>', 'x'.repeat(4001)])(
    'rejects invalid input at the service boundary',
    (body) => {
      expect(() => service.validateBody(body)).toThrow();
    },
  );

  it('maps explicit message fields without actor or conversation metadata', () => {
    const dto = service.toDto({
      id: 'message-id',
      conversationId: 'internal-conversation-id',
      sequence: 1,
      senderType: ConversationSide.PROVIDER,
      body: 'Hello',
      createdAt: new Date(),
      readAt: null,
    });
    expect(Object.keys(dto).sort()).toEqual(
      ['id', 'sequence', 'senderType', 'body', 'createdAt', 'readAt'].sort(),
    );
    expect(dto).not.toHaveProperty('conversationId');
  });
});
