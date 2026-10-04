import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ReadModelPageQueryDto {
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class ReadModelApplicationParamsDto {
  @IsUUID('4') applicationId!: string;
}

export class ReadModelListingParamsDto {
  @IsUUID('4') listingId!: string;
}

export class ReadModelRequestParamsDto extends ReadModelApplicationParamsDto {
  @IsUUID('4') requestId!: string;
}
