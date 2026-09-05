import type { Listing, ListingImage } from '../../generated/prisma/client';
import { ProfileMatch } from './applicant-listing-profile-match.enum';

export type ApplicantListingSummarySource = Pick<
  Listing,
  | 'id'
  | 'title'
  | 'city'
  | 'zip'
  | 'district'
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
  | 'petsPolicy'
  | 'smokingPolicy'
  | 'publishedAt'
> & {
  images: Pick<ListingImage, 'secureUrl' | 'position' | 'isCover'>[];
};

export class ApplicantListingSummaryDto {
  readonly id!: string;
  readonly title!: string | null;
  readonly city!: string | null;
  readonly zip!: string | null;
  readonly district!: string | null;
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
  readonly publishedAt!: Date | null;
  readonly isNew!: boolean;
  readonly petsPolicy!: string | null;
  readonly coverImage!: { readonly secureUrl: string } | null;
  readonly profileMatch!: ProfileMatch;
  readonly hasApplied!: boolean;

  constructor(
    listing: ApplicantListingSummarySource,
    profileMatch: ProfileMatch,
    evaluationTimestamp: Date,
    hasApplied: boolean,
  ) {
    const coverImage = listing.images.find((image) => image.isCover);

    this.id = listing.id;
    this.title = listing.title;
    this.city = listing.city;
    this.zip = listing.zip;
    this.district = listing.district;
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
    this.publishedAt = listing.publishedAt;
    this.isNew = this.computeIsNew(listing.publishedAt, evaluationTimestamp);
    this.petsPolicy = listing.petsPolicy;
    this.coverImage = coverImage ? { secureUrl: coverImage.secureUrl } : null;
    this.profileMatch = profileMatch;
    this.hasApplied = hasApplied;
  }

  private computeIsNew(publishedAt: Date | null, now: Date): boolean {
    if (!publishedAt) {
      return false;
    }

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return (
      publishedAt.getTime() <= now.getTime() &&
      now.getTime() < publishedAt.getTime() + sevenDaysMs
    );
  }
}
