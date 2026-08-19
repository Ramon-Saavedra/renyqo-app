import type { CreateListingDto } from '../../listings/dto/create-listing.dto';
import { ListingExtractionIssueDto } from './listing-extraction-issue.dto';

export class ListingExtractionResponseDto {
  readonly values!: Partial<CreateListingDto>;
  readonly requiredMissingFields!: string[];
  readonly recommendedMissingFields!: string[];
  readonly inconsistencies!: ListingExtractionIssueDto[];
  readonly warnings!: string[];

  constructor(input: {
    values: Partial<CreateListingDto>;
    requiredMissingFields: string[];
    recommendedMissingFields: string[];
    inconsistencies: ListingExtractionIssueDto[];
    warnings: string[];
  }) {
    this.values = input.values;
    this.requiredMissingFields = input.requiredMissingFields;
    this.recommendedMissingFields = input.recommendedMissingFields;
    this.inconsistencies = input.inconsistencies;
    this.warnings = input.warnings;
  }
}
