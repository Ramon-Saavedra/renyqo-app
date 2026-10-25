import { Transform } from 'class-transformer';
import {
  IsBoolean,
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
  ValidateIf,
  Equals,
} from 'class-validator';
import { ViewingCancellationReason } from '../../generated/prisma/enums';
import {
  ViewingInterest,
  ViewingOutcome,
  ViewingAbsenceSide,
  ViewingProviderConsideration,
} from '../../generated/prisma/enums';
import { ViewingApplicationParamsDto } from './viewing-input.dto';

export class WorkflowCommandDto {
  @IsUUID('4') requestKey!: string;
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.expectedWorkflowRevision,
  )
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedWorkflowRevision!: number;
}

export class WorkflowScheduleDto extends WorkflowCommandDto {
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/u)
  startsAt!: string;
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/u)
  endsAt!: string;
  @IsString() @Length(1, 100) timeZone!: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @Matches(/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u)
  message?: string;
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.shortNotice)
  @IsOptional()
  @IsBoolean()
  shortNotice?: boolean;
}

export class WorkflowCancelDto extends WorkflowCommandDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @Matches(/^(?![\s\S]*(?![\r\n\t])\p{Cc})[^<>]*$/u)
  message?: string;
}

export class WorkflowCloseDto extends WorkflowCancelDto {
  @IsEnum(ViewingCancellationReason) reason!: ViewingCancellationReason;
  @ValidateIf((_obj, value: unknown) => value !== null)
  @IsUUID('4')
  proposalId!: string | null;
  @ValidateIf((_obj, value: unknown) => value !== null)
  @IsUUID('4')
  appointmentId!: string | null;
}

export class WorkflowProposalParamsDto extends ViewingApplicationParamsDto {
  @IsUUID('4') proposalId!: string;
}
export class WorkflowAppointmentParamsDto extends ViewingApplicationParamsDto {
  @IsUUID('4') appointmentId!: string;
}
export class WorkflowCloseParamsDto extends ViewingApplicationParamsDto {
  @IsUUID('4') workflowId!: string;
}

export class WorkflowInterestDto extends WorkflowCommandDto {
  @IsEnum(ViewingInterest) interest!: ViewingInterest;
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.confirmWithdrawal,
  )
  @ValidateIf(
    (obj: WorkflowInterestDto) =>
      obj.interest === ViewingInterest.NOT_INTERESTED ||
      obj.confirmWithdrawal !== undefined,
  )
  @Equals(true)
  confirmWithdrawal?: boolean;
}
export class WorkflowConsiderationDto extends WorkflowCommandDto {
  @IsEnum(ViewingProviderConsideration)
  consideration!: ViewingProviderConsideration;
}
export class WorkflowOutcomeDto extends WorkflowCommandDto {
  @IsEnum(ViewingOutcome) outcome!: ViewingOutcome;
  @IsOptional() @IsEnum(ViewingAbsenceSide) absenceSide?: ViewingAbsenceSide;
  @IsOptional() @IsString() @Length(1, 500) correctionReason?: string;
}
