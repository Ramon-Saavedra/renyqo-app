import type { CreateListingDto } from '../../listings/dto/create-listing.dto';
import type {
  RecommendedListingField,
  RequiredListingPropertyField,
} from '../listing-extraction.policy';
import { ListingExtractionIssueDto } from './listing-extraction-issue.dto';

export class ListingExtractionResponseDto {
  readonly values!: Partial<CreateListingDto>;
  readonly requiredMissingFields!: RequiredListingPropertyField[];
  readonly recommendedMissingFields!: RecommendedListingField[];
  readonly inconsistencies!: ListingExtractionIssueDto[];
  readonly warnings!: string[];

  constructor(input: {
    values: Partial<CreateListingDto>;
    requiredMissingFields: RequiredListingPropertyField[];
    recommendedMissingFields: RecommendedListingField[];
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
