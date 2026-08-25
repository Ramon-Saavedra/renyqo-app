import type { Listing } from '../../generated/prisma/client';
import { ListingResponseDto } from './listing-response.dto';

export type ListingWithActiveApplicationsCount = Listing & {
  _count: {
    applications: number;
  };
};

export class ProviderListingOverviewResponseDto extends ListingResponseDto {
  readonly activeApplicationsCount: number;

  constructor(
    listing: ListingWithActiveApplicationsCount,
    options: { exposeExactAddress?: boolean } = {},
  ) {
    const { _count, ...listingFields } = listing;
    super(listingFields, options);
    this.activeApplicationsCount = _count.applications;
  }
}
