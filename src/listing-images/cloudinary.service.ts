import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import type { UploadApiResponse } from 'cloudinary';
import type { EnvironmentVariables } from '../config/env.validation';

@Injectable()
export class CloudinaryService {
  private readonly configured: boolean;

  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {
    const cloudName = this.config.get('CLOUDINARY_CLOUD_NAME', {
      infer: true,
    });
    const apiKey = this.config.get('CLOUDINARY_API_KEY', { infer: true });
    const apiSecret = this.config.get('CLOUDINARY_API_SECRET', {
      infer: true,
    });

    this.configured = Boolean(cloudName && apiKey && apiSecret);

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
    }
  }

  uploadBuffer(buffer: Buffer, folder: string): Promise<UploadApiResponse> {
    if (!this.configured) {
      return Promise.reject(
        new ServiceUnavailableException('Cloudinary is not configured'),
      );
    }

    return new Promise<UploadApiResponse>((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder, resource_type: 'image' }, (error, result) => {
          if (error || !result) {
            reject(this.toUploadError(error));
          } else {
            resolve(result);
          }
        })
        .end(buffer);
    });
  }

  async deleteByPublicId(publicId: string): Promise<void> {
    if (!this.configured) {
      throw new ServiceUnavailableException('Cloudinary is not configured');
    }

    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  }

  private toUploadError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    if (this.hasErrorMessage(error)) {
      return new Error(error.message);
    }

    return new Error('Cloudinary upload failed');
  }

  private hasErrorMessage(error: unknown): error is { message: string } {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return false;
    }

    return typeof (error as { message?: unknown }).message === 'string';
  }
}
