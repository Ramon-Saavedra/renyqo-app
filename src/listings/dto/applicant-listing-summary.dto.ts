import type { Listing, ListingImage } from '../../generated/prisma/client';

type ApplicantListingSummarySource = Pick<
  Listing,
  | 'id'
  | 'title'
  | 'city'
  | 'zip'
  | 'objectType'
  | 'livingArea'
  | 'rooms'
  | 'bedrooms'
  | 'coldRent'
  | 'additionalCosts'
  | 'deposit'
  | 'depositMonths'
  | 'availableFrom'
  | 'shortDescription'
> & {
  images: Pick<ListingImage, 'secureUrl' | 'position' | 'isCover'>[];
};

export class ApplicantListingSummaryDto {
  readonly id!: string;
  readonly title!: string | null;
  readonly city!: string | null;
  readonly zip!: string | null;
  readonly objectType!: string | null;
  readonly livingArea!: number | null;
  readonly rooms!: number | null;
  readonly bedrooms!: number | null;
  readonly coldRent!: number | null;
  readonly additionalCosts!: number | null;
  readonly deposit!: number | null;
  readonly depositMonths!: number | null;
  readonly availableFrom!: Date | null;
  readonly shortDescription!: string | null;
  readonly coverImage!: { readonly secureUrl: string } | null;

  constructor(listing: ApplicantListingSummarySource) {
    const coverImage = listing.images.find((image) => image.isCover);

    this.id = listing.id;
    this.title = listing.title;
    this.city = listing.city;
    this.zip = listing.zip;
    this.objectType = listing.objectType;
    this.livingArea = listing.livingArea;
    this.rooms = listing.rooms;
    this.bedrooms = listing.bedrooms;
    this.coldRent = listing.coldRent;
    this.additionalCosts = listing.additionalCosts;
    this.deposit = listing.deposit;
    this.depositMonths = listing.depositMonths;
    this.availableFrom = listing.availableFrom;
    this.shortDescription = listing.shortDescription;
    this.coverImage = coverImage ? { secureUrl: coverImage.secureUrl } : null;
  }
}
