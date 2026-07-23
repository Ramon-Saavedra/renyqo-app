import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { EnvironmentVariables } from '../config/env.validation';
import type { ListingImage, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from './cloudinary.service';
import { ListingImageItemDto } from './dto/listing-image-item.dto';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';
import type { ReorderListingImagesDto } from './dto/reorder-listing-images.dto';

type OrderedListingImage = Pick<ListingImage, 'id' | 'secureUrl'>;

@Injectable()
export class ListingImagesService {
  private readonly logger = new Logger(ListingImagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async upload(
    listingId: string,
    providerId: string,
    file: Express.Multer.File,
  ): Promise<ListingImageResponseDto> {
    await this.assertListingOwnership(listingId, providerId);

    const folder = `${this.config.get('CLOUDINARY_FOLDER')}/listings/${listingId}`;
    const uploaded = await this.cloudinaryService.uploadBuffer(
      file.buffer,
      folder,
    );

    try {
      const image = await this.prisma.$transaction(async (tx) => {
        const latestImage = await tx.listingImage.findFirst({
          where: { listingId },
          orderBy: { position: 'desc' },
          select: { position: true },
        });

        const position = latestImage ? latestImage.position + 1 : 0;

        const image = await tx.listingImage.create({
          data: {
            listingId,
            publicId: uploaded.public_id,
            secureUrl: uploaded.secure_url,
            position,
            isCover: position === 0,
          },
        });

        await tx.listing.update({
          where: { id: listingId },
          data: { photos: { push: uploaded.secure_url } },
        });

        return image;
      });

      return ListingImageResponseDto.fromListingImage(image);
    } catch (err) {
      await this.deleteUploadedAssetAfterFailure(uploaded.public_id);

      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Listing image upload conflicted');
      }
      throw err;
    }
  }

  async findAllByListing(
    listingId: string,
    providerId: string,
  ): Promise<ListingImageItemDto[]> {
    await this.assertListingOwnership(listingId, providerId);

    const images = await this.prisma.listingImage.findMany({
      where: { listingId },
      orderBy: { position: 'asc' },
    });

    return images.map((image) => ListingImageItemDto.fromListingImage(image));
  }

  async remove(
    listingId: string,
    imageId: string,
    providerId: string,
  ): Promise<void> {
    await this.assertListingOwnership(listingId, providerId);

    const image = await this.prisma.listingImage.findFirst({
      where: { id: imageId, listingId },
      select: { id: true, publicId: true },
    });

    if (!image) {
      throw new NotFoundException('Listing image not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.listingImage.deleteMany({ where: { id: image.id } });

      const remaining = await tx.listingImage.findMany({
        where: { listingId },
        orderBy: { position: 'asc' },
        select: { id: true, secureUrl: true },
      });

      await this.applyImageOrder(tx, listingId, remaining);
    });

    await this.deleteAssetAfterRemoval(image.publicId);
  }

  async reorder(
    listingId: string,
    providerId: string,
    dto: ReorderListingImagesDto,
  ): Promise<ListingImageItemDto[]> {
    await this.assertListingOwnership(listingId, providerId);

    const reordered = await this.prisma.$transaction(async (tx) => {
      const images = await tx.listingImage.findMany({
        where: { listingId },
        orderBy: { position: 'asc' },
        select: { id: true, secureUrl: true },
      });

      const orderedImages = this.resolveRequestedOrder(images, dto.imageIds);
      await this.applyImageOrder(tx, listingId, orderedImages);

      return tx.listingImage.findMany({
        where: { listingId },
        orderBy: { position: 'asc' },
      });
    });

    return reordered.map((image) =>
      ListingImageItemDto.fromListingImage(image),
    );
  }

  private resolveRequestedOrder(
    images: readonly OrderedListingImage[],
    imageIds: readonly string[],
  ): OrderedListingImage[] {
    if (new Set(imageIds).size !== imageIds.length) {
      throw new BadRequestException('imageIds must not contain duplicates');
    }

    const imagesById = new Map(images.map((image) => [image.id, image]));

    if (imageIds.length !== images.length) {
      throw new BadRequestException(
        'imageIds must contain every image of the listing exactly once',
      );
    }

    return imageIds.map((id) => {
      const image = imagesById.get(id);
      if (!image) {
        throw new BadRequestException(
          'imageIds must contain every image of the listing exactly once',
        );
      }
      return image;
    });
  }

  private async applyImageOrder(
    tx: Prisma.TransactionClient,
    listingId: string,
    orderedImages: readonly OrderedListingImage[],
  ): Promise<void> {
    for (const [index, image] of orderedImages.entries()) {
      await tx.listingImage.update({
        where: { id: image.id },
        data: { position: -(index + 1) },
      });
    }

    for (const [index, image] of orderedImages.entries()) {
      await tx.listingImage.update({
        where: { id: image.id },
        data: { position: index, isCover: index === 0 },
      });
    }

    await tx.listing.update({
      where: { id: listingId },
      data: { photos: orderedImages.map((image) => image.secureUrl) },
    });
  }

  private async assertListingOwnership(
    listingId: string,
    providerId: string,
  ): Promise<void> {
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
  }

  private async deleteUploadedAssetAfterFailure(
    publicId: string,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteByPublicId(publicId);
    } catch (err) {
      this.logger.error(
        'Failed to delete Cloudinary asset after database failure',
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  private async deleteAssetAfterRemoval(publicId: string): Promise<void> {
    try {
      await this.cloudinaryService.deleteByPublicId(publicId);
    } catch (err) {
      this.logger.error(
        'Failed to delete Cloudinary asset after image removal',
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
