import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class ConversationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2147483646)
  afterSequence = 0;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
