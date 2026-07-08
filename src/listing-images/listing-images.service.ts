import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from './cloudinary.service';
import { ListingImageResponseDto } from './dto/listing-image-response.dto';

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
    const listing = await this.prisma.listing.findFirst({
      where: { id: listingId, providerId },
      select: { id: true },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found');
    }

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
}
