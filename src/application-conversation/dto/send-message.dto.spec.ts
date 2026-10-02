import { ValidationPipe } from '@nestjs/common';
import { SendMessageDto } from './send-message.dto';
import { ConversationQueryDto } from './conversation-query.dto';
import { MarkConversationReadDto } from './mark-conversation-read.dto';
import { ApplicationConversationParamsDto } from './application-conversation-params.dto';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

describe('Conversation input DTOs', () => {
  it('trims text and preserves line breaks and Unicode', async () => {
    await expect(
      pipe.transform(
        { body: '  Hallo\nGrüße 👋  ' },
        {
          type: 'body',
          metatype: SendMessageDto,
        },
      ),
    ).resolves.toEqual({ body: 'Hallo\nGrüße 👋' });
  });

  it.each(['', '   ', '\n\t', 'x'.repeat(4001), '<b>hello</b>', 'hello\u0000'])(
    'rejects invalid text %j',
    async (body) => {
      await expect(
        pipe.transform({ body }, { type: 'body', metatype: SendMessageDto }),
      ).rejects.toThrow();
    },
  );

  it('accepts the maximum length', async () => {
    await expect(
      pipe.transform(
        { body: 'x'.repeat(4000) },
        { type: 'body', metatype: SendMessageDto },
      ),
    ).resolves.toHaveProperty('body', 'x'.repeat(4000));
  });

  it.each([123, true, null, ['hello'], { text: 'hello' }])(
    'rejects non-string bodies despite implicit conversion %j',
    async (body) => {
      await expect(
        pipe.transform({ body }, { type: 'body', metatype: SendMessageDto }),
      ).rejects.toThrow();
    },
  );

  it('rejects attachments and unknown fields', async () => {
    await expect(
      pipe.transform(
        { body: 'hello', attachment: 'file' },
        { type: 'body', metatype: SendMessageDto },
      ),
    ).rejects.toThrow();
  });

  it.each([
    { afterSequence: -1 },
    { limit: 101 },
    { limit: 0 },
    { afterSequence: 'invalid' },
  ])('rejects invalid pagination %j', async (query) => {
    await expect(
      pipe.transform(query, { type: 'query', metatype: ConversationQueryDto }),
    ).rejects.toThrow();
  });

  it('sets bounded pagination defaults', async () => {
    await expect(
      pipe.transform({}, { type: 'query', metatype: ConversationQueryDto }),
    ).resolves.toEqual({ afterSequence: 0, limit: 50 });
  });

  it('rejects invalid application IDs', async () => {
    await expect(
      pipe.transform(
        { applicationId: 'invalid' },
        { type: 'param', metatype: ApplicationConversationParamsDto },
      ),
    ).rejects.toThrow();
  });

  it.each([0, -1, 1.5, 2147483648])(
    'rejects invalid read sequence %s',
    async (throughSequence) => {
      await expect(
        pipe.transform(
          { throughSequence },
          { type: 'body', metatype: MarkConversationReadDto },
        ),
      ).rejects.toThrow();
    },
  );
});
