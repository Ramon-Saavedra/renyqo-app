import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ListingReportReason } from '../../generated/prisma/enums';

export class ReportListingDto {
  @IsEnum(ListingReportReason)
  reason!: ListingReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  detail?: string;
}
