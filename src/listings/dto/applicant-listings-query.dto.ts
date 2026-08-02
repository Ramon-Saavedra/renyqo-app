import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ACTIVE_PAGE_SIZE_DEFAULT = 20;
const ACTIVE_PAGE_SIZE_MAX = 50;
const CURSOR_MAX_LENGTH = 256;

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

export class ApplicantListingsQueryDto {
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
