import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const APPLICANT_APPLICATION_OVERVIEW_GROUPS = [
  'ALL',
  'ACTIVE',
  'WAITING',
  'DONE',
] as const;

export type ApplicantApplicationOverviewGroup =
  (typeof APPLICANT_APPLICATION_OVERVIEW_GROUPS)[number];

export class ReadModelPageQueryDto {
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional()
  @IsIn(APPLICANT_APPLICATION_OVERVIEW_GROUPS)
  group?: ApplicantApplicationOverviewGroup;
}

export class ReadModelApplicationParamsDto {
  @IsUUID('4') applicationId!: string;
}

export class ReadModelListingParamsDto {
  @IsUUID('4') listingId!: string;
}

export class ReadModelRequestParamsDto extends ReadModelApplicationParamsDto {
  @IsUUID('4') requestId!: string;
}
