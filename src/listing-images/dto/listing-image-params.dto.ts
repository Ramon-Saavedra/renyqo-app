import { IsUUID } from 'class-validator';

export class ListingImageParamsDto {
  @IsUUID('4')
  listingId!: string;
}
