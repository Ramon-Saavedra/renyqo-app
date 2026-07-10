import type { Listing } from '../../generated/prisma/client';

export class ListingResponseDto {
  readonly id!: Listing['id'];
  readonly providerId!: Listing['providerId'];
  readonly status!: Listing['status'];
  readonly city!: Listing['city'];
  readonly zip!: Listing['zip'];
  readonly street!: Listing['street'];
  readonly country!: Listing['country'];
  readonly showExactAddress!: Listing['showExactAddress'];
  readonly objectType!: Listing['objectType'];
  readonly livingArea!: Listing['livingArea'];
  readonly rooms!: Listing['rooms'];
  readonly bedrooms!: Listing['bedrooms'];
  readonly coldRent!: Listing['coldRent'];
  readonly additionalCosts!: Listing['additionalCosts'];
  readonly deposit!: Listing['deposit'];
  readonly availableFrom!: Listing['availableFrom'];
  readonly title!: Listing['title'];
  readonly shortDescription!: Listing['shortDescription'];
  readonly photos!: Listing['photos'];
  readonly minimumHouseholdNetIncome!: Listing['minimumHouseholdNetIncome'];
  readonly schufaRequired!: Listing['schufaRequired'];
  readonly incomeProofRequired!: Listing['incomeProofRequired'];
  readonly suitableForPeopleCount!: Listing['suitableForPeopleCount'];
  readonly petsPolicy!: Listing['petsPolicy'];
  readonly smokingPolicy!: Listing['smokingPolicy'];
  readonly createdAt!: Listing['createdAt'];
  readonly updatedAt!: Listing['updatedAt'];
  readonly publishedAt!: Listing['publishedAt'];

  constructor(
    listing: Listing,
    options: { exposeExactAddress?: boolean } = {},
  ) {
    Object.assign(this, {
      ...listing,
      street:
        options.exposeExactAddress || listing.showExactAddress
          ? listing.street
          : null,
    });
  }
}
