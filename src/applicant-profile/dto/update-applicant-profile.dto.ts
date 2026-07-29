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
  householdNetIncome?: number;

  @IsOptional()
  @IsBoolean()
  incomeProofAvailable?: boolean;

  @IsOptional()
  @IsBoolean()
  schufaAvailable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  adultsCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  childrenCount?: number;

  @IsOptional()
  @IsBoolean()
  hasPets?: boolean;

  @IsOptional()
  @IsString()
  @Transform(toNullIfBlank)
  @MaxLength(500)
  petsNote?: string | null;

  @IsOptional()
  @IsEnum(SmokingStatus)
  smokingStatus?: SmokingStatus;
}
