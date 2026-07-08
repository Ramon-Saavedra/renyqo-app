import type { ListingImage } from '../../generated/prisma/client';

export class ListingImageResponseDto {
  id!: string;
  listingId!: string;
  secureUrl!: string;
  position!: number;
  isCover!: boolean;
  createdAt!: Date;

  constructor(image: ListingImage) {
    this.id = image.id;
    this.listingId = image.listingId;
    this.secureUrl = image.secureUrl;
    this.position = image.position;
    this.isCover = image.isCover;
    this.createdAt = image.createdAt;
  }

  static fromListingImage(image: ListingImage): ListingImageResponseDto {
    return new ListingImageResponseDto(image);
  }
}
