import { Type } from 'class-transformer';
import {
  IsInt,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { NotificationCategory } from './notification-category';

export class NotificationQueryDto {
  @IsOptional() @IsEnum(NotificationCategory) category?: NotificationCategory;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
  @IsOptional() @IsISO8601({ strict: true }) beforeCreatedAt?: string;
  @IsOptional() @IsUUID() beforeId?: string;
}
export class NotificationParamsDto {
  @IsUUID() notificationId!: string;
}
export class NotificationReadAllDto {
  // Only notifications created through this server-issued snapshot are marked.
  @IsISO8601({ strict: true }) throughCreatedAt!: string;
}
