import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

import { SmokingStatus } from '../../generated/prisma/enums';

const toNullIfBlank = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
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
  incomeProofAvailable?: boolean | null;

  @IsOptional()
  @IsBoolean()
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
  hasPets?: boolean | null;

  @IsOptional()
  @IsString()
  @Transform(toNullIfBlank)
  @MaxLength(500)
  petsNote?: string | null;

  @IsOptional()
  @IsEnum(SmokingStatus)
  smokingStatus?: SmokingStatus | null;
}
