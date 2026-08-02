import type { ListingImage } from '../../generated/prisma/client';

type ApplicantListingImageSource = Pick<
  ListingImage,
  'secureUrl' | 'position' | 'isCover'
>;

export class ApplicantListingImageDto {
  readonly secureUrl!: string;
  readonly position!: number;
  readonly isCover!: boolean;

  constructor(image: ApplicantListingImageSource) {
    this.secureUrl = image.secureUrl;
    this.position = image.position;
    this.isCover = image.isCover;
  }
}
