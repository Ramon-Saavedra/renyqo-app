import type { Listing, ListingImage } from '../../generated/prisma/client';
import { ListingImageItemDto } from '../../listing-images/dto/listing-image-item.dto';

export type ListingWithImages = Listing & { images?: ListingImage[] };

export class ListingResponseDto {
  readonly id!: Listing['id'];
  readonly workspaceId!: Listing['workspaceId'];
  readonly createdByMembershipId!: Listing['createdByMembershipId'];
  readonly responsibleMembershipId!: Listing['responsibleMembershipId'];
  readonly revision!: Listing['revision'];
  readonly status!: Listing['status'];
  readonly city!: Listing['city'];
  readonly zip!: Listing['zip'];
  readonly street!: Listing['street'];
  readonly district!: Listing['district'];
  readonly country!: Listing['country'];
  readonly showExactAddress!: Listing['showExactAddress'];
  readonly objectType!: Listing['objectType'];
  readonly livingArea!: Listing['livingArea'];
  readonly rooms!: Listing['rooms'];
  readonly bedrooms!: Listing['bedrooms'];
  readonly coldRent!: Listing['coldRent'];
  readonly additionalCosts!: Listing['additionalCosts'];
  readonly deposit!: Listing['deposit'];
  readonly depositMonths!: Listing['depositMonths'];
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
  readonly rentedAt!: Listing['rentedAt'];
  readonly images?: ListingImageItemDto[];

  constructor(
    listing: ListingWithImages,
    options: { exposeExactAddress?: boolean } = {},
  ) {
    Object.assign(this, {
      id: listing.id,
      workspaceId: listing.workspaceId,
      createdByMembershipId: listing.createdByMembershipId,
      responsibleMembershipId: listing.responsibleMembershipId,
      revision: listing.revision,
      status: listing.status,
      city: listing.city,
      zip: listing.zip,
      district: listing.district,
      country: listing.country,
      showExactAddress: listing.showExactAddress,
      objectType: listing.objectType,
      livingArea: listing.livingArea,
      rooms: listing.rooms,
      bedrooms: listing.bedrooms,
      coldRent: listing.coldRent,
      additionalCosts: listing.additionalCosts,
      deposit: listing.deposit,
      depositMonths: listing.depositMonths,
      availableFrom: listing.availableFrom,
      title: listing.title,
      shortDescription: listing.shortDescription,
      photos: listing.photos,
      minimumHouseholdNetIncome: listing.minimumHouseholdNetIncome,
      schufaRequired: listing.schufaRequired,
      incomeProofRequired: listing.incomeProofRequired,
      suitableForPeopleCount: listing.suitableForPeopleCount,
      petsPolicy: listing.petsPolicy,
      smokingPolicy: listing.smokingPolicy,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      publishedAt: listing.publishedAt,
      rentedAt: listing.rentedAt,
      street:
        options.exposeExactAddress || listing.showExactAddress
          ? listing.street
          : null,
      images: listing.images?.map((image) =>
        ListingImageItemDto.fromListingImage(image),
      ),
    });
  }
}
