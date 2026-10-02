import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

export const MAX_MESSAGE_LENGTH = 4000;
export const PLAIN_TEXT_MESSAGE = /^(?:[^\p{Cc}<>]|\r|\n|\t)*$/u;

export class SendMessageDto {
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj['body'] === 'string' ? obj['body'].trim() : obj['body'],
  )
  @IsString()
  @Length(1, MAX_MESSAGE_LENGTH)
  @Matches(PLAIN_TEXT_MESSAGE, {
    message: 'body must be plain text without markup or control characters',
  })
  body!: string;
}
