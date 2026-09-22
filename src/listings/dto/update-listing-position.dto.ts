import { IsInt, Min } from 'class-validator';

export class UpdateListingPositionDto {
  @IsInt()
  @Min(1)
  position!: number;
}
