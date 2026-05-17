import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import {
  ObjectType,
  PetsPolicy,
  SmokingPolicy,
} from '../../generated/prisma/enums';

export class CreateListingDto {
  @IsEnum(ObjectType)
  objectType!: ObjectType;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsString()
  @IsNotEmpty()
  zip!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  street?: string;

  @IsOptional()
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
  @IsNumber()
  @Min(0)
  minimumHouseholdNetIncome?: number;

  @IsOptional()
  @IsBoolean()
  schufaRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  incomeProofRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  suitableForPeopleCount?: number;

  @IsOptional()
  @IsEnum(PetsPolicy)
  petsPolicy?: PetsPolicy;

  @IsOptional()
  @IsEnum(SmokingPolicy)
  smokingPolicy?: SmokingPolicy;
}
