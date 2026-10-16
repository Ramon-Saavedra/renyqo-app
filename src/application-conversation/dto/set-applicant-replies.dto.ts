import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';
export class SetApplicantRepliesDto {
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) =>
      obj['applicantRepliesEnabled'],
  )
  @IsBoolean()
  applicantRepliesEnabled!: boolean;
}
