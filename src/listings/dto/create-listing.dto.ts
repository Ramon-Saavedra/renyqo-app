import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';

import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';

const toOptionalBoolean = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return value;
};

const toOptionalNumber = ({ value }: TransformFnParams): unknown => {
  if (value === undefined || value === null || typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : value;
};

export class CreateListingDto {
  @IsOptional()
  @IsEnum(ObjectType)
  objectType?: ObjectType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  city?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  zip?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  street?: string;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  showExactAddress?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  livingArea?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rooms?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bedrooms?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  coldRent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  additionalCosts?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  depositMonths?: number;

  @IsOptional()
  @IsDateString()
  availableFrom?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  shortDescription?: string;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  minimumHouseholdNetIncome?: number | null;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  schufaRequired?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  incomeProofRequired?: boolean;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  suitableForPeopleCount?: number | null;

  @IsOptional()
  @IsEnum(PetsPolicy)
  petsPolicy?: PetsPolicy | null;

  @IsOptional()
  @IsEnum(SmokingPolicy)
  smokingPolicy?: SmokingPolicy | null;
}
