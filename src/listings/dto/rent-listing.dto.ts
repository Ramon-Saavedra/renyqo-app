import { IsUUID } from 'class-validator';

export class RentListingDto {
  @IsUUID('4')
  selectedApplicationId!: string;
}
