import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { LISTING_SOURCE_MAX_CHARACTERS } from '../listing-extraction.policy';

export class ExtractListingTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(LISTING_SOURCE_MAX_CHARACTERS)
  text!: string;
}
