import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PetsPolicy } from '../../generated/prisma/enums';

const ACTIVE_PAGE_SIZE_DEFAULT = 20;
const ACTIVE_PAGE_SIZE_MAX = 50;
const CURSOR_MAX_LENGTH = 256;
const QUERY_MAX_LENGTH = 200;

const DISCOVERY_SORTS = [
  'newest',
  'price-asc',
  'price-desc',
  'area-desc',
] as const;
export type DiscoverySort = (typeof DISCOVERY_SORTS)[number];

const toOptionalNumber = ({ value }: { value: unknown }): unknown => {
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

const toStrictBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  return value;
};

export class ApplicantListingsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(QUERY_MAX_LENGTH)
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
  })
  query?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  minRent?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  maxRent?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  minRooms?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  maxRooms?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  minLivingArea?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber()
  @Min(0)
  maxLivingArea?: number;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'availableBy must be a date in YYYY-MM-DD format',
  })
  availableBy?: string;

  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  onlyMatching?: boolean;

  @IsOptional()
  @IsIn(DISCOVERY_SORTS)
  sort?: DiscoverySort;

  @IsOptional()
  @IsEnum(PetsPolicy)
  petsPolicy?: PetsPolicy;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return ACTIVE_PAGE_SIZE_DEFAULT;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : ACTIVE_PAGE_SIZE_DEFAULT;
    }

    if (typeof value !== 'string') {
      return ACTIVE_PAGE_SIZE_DEFAULT;
    }

    const normalized = value.trim();

    if (normalized.length === 0) {
      return ACTIVE_PAGE_SIZE_DEFAULT;
    }

    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : ACTIVE_PAGE_SIZE_DEFAULT;
  })
  @IsInt()
  @Min(1)
  @Max(ACTIVE_PAGE_SIZE_MAX)
  limit?: number = ACTIVE_PAGE_SIZE_DEFAULT;

  @IsOptional()
  @IsString()
  @MaxLength(CURSOR_MAX_LENGTH)
  cursor?: string;
}
