import type { Listing, ListingImage } from '../../generated/prisma/client';
import type { ApplicationRejectionReason } from '../../generated/prisma/enums';
import { ApplicationStatus } from '../../generated/prisma/enums';
import type { ApplicantListingApplicationStateFields } from '../../applications/applicant-listing-application-state';
import { ApplicantListingImageDto } from './applicant-listing-image.dto';
import { ProfileMatch } from './applicant-listing-profile-match.enum';

type ApplicantListingDetailSource = Pick<
  Listing,
  | 'id'
  | 'title'
  | 'city'
  | 'zip'
  | 'district'
  | 'street'
  | 'showExactAddress'
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
  | 'minimumHouseholdNetIncome'
  | 'schufaRequired'
  | 'incomeProofRequired'
  | 'suitableForPeopleCount'
  | 'petsPolicy'
  | 'smokingPolicy'
  | 'publishedAt'
> & {
  images: Pick<ListingImage, 'secureUrl' | 'position' | 'isCover'>[];
};

export class ApplicantListingDetailDto {
  readonly id!: string;
  readonly title!: string | null;
  readonly city!: string | null;
  readonly zip!: string | null;
  readonly district!: string | null;
  readonly street!: string | null;
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
  readonly images!: ApplicantListingImageDto[];
  readonly profileMatch!: ProfileMatch;
  readonly hasApplied!: boolean;
  readonly applicationStatus!: ApplicationStatus | null;
  readonly publicReason!: ApplicationRejectionReason | null;
  readonly requirements!: {
    readonly minimumHouseholdNetIncome: number | null;
    readonly schufaRequired: boolean;
    readonly incomeProofRequired: boolean;
    readonly suitableForPeopleCount: number | null;
    readonly petsPolicy: string | null;
    readonly smokingPolicy: string | null;
  };

  constructor(
    listing: ApplicantListingDetailSource,
    profileMatch: ProfileMatch,
    evaluationTimestamp: Date,
    applicationState: ApplicantListingApplicationStateFields,
  ) {
    this.id = listing.id;
    this.title = listing.title;
    this.city = listing.city;
    this.zip = listing.zip;
    this.district = listing.district;
    this.street = listing.showExactAddress ? listing.street : null;
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
    this.images = listing.images.map(
      (image) => new ApplicantListingImageDto(image),
    );
    this.profileMatch = profileMatch;
    this.hasApplied = applicationState.hasApplied;
    this.applicationStatus = applicationState.applicationStatus;
    this.publicReason = applicationState.publicReason;
    this.requirements = {
      minimumHouseholdNetIncome: listing.minimumHouseholdNetIncome,
      schufaRequired: listing.schufaRequired,
      incomeProofRequired: listing.incomeProofRequired,
      suitableForPeopleCount: listing.suitableForPeopleCount,
      petsPolicy: listing.petsPolicy,
      smokingPolicy: listing.smokingPolicy,
    };
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
