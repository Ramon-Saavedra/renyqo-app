import type { CreateListingDto } from '../../listings/dto/create-listing.dto';
import { ListingExtractionIssueDto } from './listing-extraction-issue.dto';

export class ListingExtractionResponseDto {
  readonly values!: Partial<CreateListingDto>;
  readonly missingFields!: string[];
  readonly inconsistencies!: ListingExtractionIssueDto[];
  readonly warnings!: string[];

  constructor(input: {
    values: Partial<CreateListingDto>;
    missingFields: string[];
    inconsistencies: ListingExtractionIssueDto[];
    warnings: string[];
  }) {
    this.values = input.values;
    this.missingFields = input.missingFields;
    this.inconsistencies = input.inconsistencies;
    this.warnings = input.warnings;
  }
}
