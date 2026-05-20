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

import { SmokingStatus } from '../../generated/prisma/enums';

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
  peopleCount?: number;

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
  @MaxLength(500)
  petsNote?: string;

  @IsOptional()
  @IsEnum(SmokingStatus)
  smokingStatus?: SmokingStatus;
}
