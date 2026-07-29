import type { ListingImage } from '../../generated/prisma/client';

type ListingImageItemSource = Pick<
  ListingImage,
  'id' | 'secureUrl' | 'position' | 'isCover'
>;

export class ListingImageItemDto {
  readonly id!: string;
  readonly secureUrl!: string;
  readonly position!: number;
  readonly isCover!: boolean;

  constructor(image: ListingImageItemSource) {
    this.id = image.id;
    this.secureUrl = image.secureUrl;
    this.position = image.position;
    this.isCover = image.isCover;
  }

  static fromListingImage(image: ListingImageItemSource): ListingImageItemDto {
    return new ListingImageItemDto(image);
  }
}
