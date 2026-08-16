import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ExtractListingTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  text!: string;
}
