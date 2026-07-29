import { IsUUID } from 'class-validator';

export class ListingImageItemParamsDto {
  @IsUUID('4')
  listingId!: string;

  @IsUUID('4')
  imageId!: string;
}
