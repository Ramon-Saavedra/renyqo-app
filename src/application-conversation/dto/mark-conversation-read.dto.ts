import { IsInt, Max, Min } from 'class-validator';

export class MarkConversationReadDto {
  @IsInt()
  @Min(1)
  @Max(2147483647)
  throughSequence!: number;
}
