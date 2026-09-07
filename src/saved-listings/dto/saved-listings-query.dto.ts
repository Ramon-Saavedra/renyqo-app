import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const SAVED_LISTINGS_PAGE_SIZE_DEFAULT = 20;
const SAVED_LISTINGS_PAGE_SIZE_MAX = 50;
const CURSOR_MAX_LENGTH = 256;

export class SavedListingsQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return SAVED_LISTINGS_PAGE_SIZE_DEFAULT;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : SAVED_LISTINGS_PAGE_SIZE_DEFAULT;
    }

    if (typeof value !== 'string') {
      return SAVED_LISTINGS_PAGE_SIZE_DEFAULT;
    }

    const normalized = value.trim();

    if (normalized.length === 0) {
      return SAVED_LISTINGS_PAGE_SIZE_DEFAULT;
    }

    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : SAVED_LISTINGS_PAGE_SIZE_DEFAULT;
  })
  @IsInt()
  @Min(1)
  @Max(SAVED_LISTINGS_PAGE_SIZE_MAX)
  limit?: number = SAVED_LISTINGS_PAGE_SIZE_DEFAULT;

  @IsOptional()
  @IsString()
  @MaxLength(CURSOR_MAX_LENGTH)
  cursor?: string;
}
