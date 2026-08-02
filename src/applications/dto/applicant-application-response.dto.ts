import type {
  Application,
  Listing,
  ListingImage,
} from '../../generated/prisma/client';
import type { ApplicationRejectionReason } from '../../generated/prisma/enums';

export type ApplicantApplicationRecord = Application & {
  listing: Pick<Listing, 'id' | 'title' | 'city' | 'coldRent'> & {
    images: Pick<ListingImage, 'secureUrl' | 'isCover' | 'position'>[];
  };
};

export class ApplicantApplicationResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly status: Application['status'];
  readonly rejectedAt: Date | null;
  readonly publicReason: ApplicationRejectionReason | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly listing: {
    readonly title: Listing['title'];
    readonly city: Listing['city'];
    readonly coldRent: Listing['coldRent'];
    readonly imageUrl: string | null;
  };

  constructor(application: ApplicantApplicationRecord) {
    const coverImage =
      application.listing.images.find((image) => image.isCover) ??
      application.listing.images[0];

    this.id = application.id;
    this.listingId = application.listingId;
    this.status = application.status;
    this.rejectedAt = application.rejectedAt;
    this.publicReason = application.publicReason;
    this.createdAt = application.createdAt;
    this.updatedAt = application.updatedAt;
    this.listing = {
      title: application.listing.title,
      city: application.listing.city,
      coldRent: application.listing.coldRent,
      imageUrl: coverImage?.secureUrl ?? null,
    };
  }
}
