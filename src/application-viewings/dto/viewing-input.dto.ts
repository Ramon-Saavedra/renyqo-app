import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ViewingInterest, ViewingOutcome } from '../../generated/prisma/enums';

function textField(key: string) {
  return Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj[key] === 'string' ? obj[key].trim() : obj[key],
  );
}

export class ViewingApplicationParamsDto {
  @IsUUID('4') applicationId!: string;
}

export class ViewingParamsDto extends ViewingApplicationParamsDto {
  @IsUUID('4') viewingId!: string;
}

export class ViewingQueryDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(2147483646) beforeRound = 0;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class ProposeViewingDto {
  @IsUUID('4') requestKey!: string;
  @textField('startsAt')
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/u)
  startsAt!: string;
  @textField('endsAt')
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/u)
  endsAt!: string;
  @textField('timeZone') @IsString() @Length(1, 100) timeZone!: string;
  @IsOptional()
  @textField('providerNote')
  @IsString()
  @Length(1, 500)
  @Matches(/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u)
  providerNote?: string;
}

export class RequestViewingChangeDto {
  @IsOptional()
  @textField('message')
  @IsString()
  @Length(1, 500)
  @Matches(/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u)
  message?: string;
}

export class CorrectViewingOutcomeDto {
  @IsEnum(ViewingOutcome) outcome!: ViewingOutcome;
  @textField('reason')
  @IsString()
  @Length(1, 500)
  @Matches(/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u)
  reason!: string;
}

export class SubmitViewingInterestDto {
  @IsEnum(ViewingInterest) interest!: ViewingInterest;
}

export class ViewingActionDto {}
