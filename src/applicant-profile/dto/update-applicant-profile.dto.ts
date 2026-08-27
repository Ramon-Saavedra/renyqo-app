import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

const toOptionalBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return value;
};

export class UpdateApplicantProfileDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  householdNetIncome?: number | null;

  @IsOptional()
  @IsBoolean()
  @Transform(toOptionalBoolean)
  incomeProofAvailable?: boolean | null;

  @IsOptional()
  @IsBoolean()
  @Transform(toOptionalBoolean)
  schufaAvailable?: boolean | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  adultsCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  childrenCount?: number | null;

  @IsOptional()
  @IsBoolean()
  @Transform(toOptionalBoolean)
  hasPets?: boolean | null;

  @IsOptional()
  @IsBoolean()
  @Transform(toOptionalBoolean)
  isSmoker?: boolean | null;
}
