import { IsDateString, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class ListingAssignmentDto {
  @IsUUID('4') targetMembershipId!: string;
  @IsInt() @Min(1) expectedListingRevision!: number;
  @IsUUID('4') commandId!: string;
  @IsOptional() @IsUUID('4') correlationId?: string;
}

export class ListingTransferRequestDto extends ListingAssignmentDto {
  @IsDateString() expiresAt!: string;
}
