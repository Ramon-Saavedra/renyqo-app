import { Injectable } from '@nestjs/common';

import { ListingResponseDto } from './dto/listing-response.dto';
import type { ListingWithImages } from './dto/listing-response.dto';
import {
  ProviderListingOverviewResponseDto,
  type ListingWithActiveApplicationsCount,
} from './dto/provider-listing-overview-response.dto';

type ListingResponseOptions = { exposeExactAddress?: boolean };

@Injectable()
export class ListingResponseMapper {
  toListingResponse(
    listing: ListingWithImages,
    options: ListingResponseOptions = {},
  ): ListingResponseDto {
    return new ListingResponseDto(listing, options);
  }

  toListingResponses(
    listings: readonly ListingWithImages[],
    options: ListingResponseOptions = {},
  ): ListingResponseDto[] {
    return listings.map((listing) => this.toListingResponse(listing, options));
  }

  toProviderListingOverviewResponses(
    listings: readonly ListingWithActiveApplicationsCount[],
    options: ListingResponseOptions = {},
  ): ProviderListingOverviewResponseDto[] {
    return listings.map(
      (listing) => new ProviderListingOverviewResponseDto(listing, options),
    );
  }
}
