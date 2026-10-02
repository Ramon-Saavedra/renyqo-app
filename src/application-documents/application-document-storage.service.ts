import {
  Injectable,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { ApplicationDocumentConfigService } from './application-document-config.service';
import type { ApplicationDocumentFile } from '../generated/prisma/client';

@Injectable()
export class ApplicationDocumentStorageService {
  private readonly client: S3Client;
  constructor(private readonly config: ApplicationDocumentConfigService) {
    this.client = new S3Client({
      region: config.region,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 15000,
        throwOnRequestTimeout: true,
      },
    });
  }

  async put(
    file: ApplicationDocumentFile,
    buffer: Buffer,
  ): Promise<{ versionId: string; etag: string }> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: file.bucket,
        Key: file.storageKey,
        Body: buffer,
        ContentType: file.mimeType,
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(file.checksum, 'hex').toString('base64'),
        Metadata: { 'upload-attempt': file.id, sha256: file.checksum },
        ExpectedBucketOwner: this.config.account,
      }),
    );
    if (!result.VersionId || result.VersionId === 'null' || !result.ETag)
      throw new ServiceUnavailableException(
        'Document storage must be versioned',
      );
    return {
      versionId: result.VersionId,
      etag: result.ETag.replaceAll('"', ''),
    };
  }

  async evidence(
    file: ApplicationDocumentFile,
  ): Promise<'CLEAN' | 'PENDING' | 'UNSAFE'> {
    if (!file.versionId || file.bucket !== this.config.bucket) return 'UNSAFE';
    const input = {
      Bucket: file.bucket,
      Key: file.storageKey,
      VersionId: file.versionId,
      ExpectedBucketOwner: this.config.account,
    };
    const head = await this.client.send(new HeadObjectCommand(input));
    if (
      head.VersionId !== file.versionId ||
      head.Metadata?.['upload-attempt'] !== file.id ||
      head.Metadata?.sha256 !== file.checksum ||
      head.ContentLength !== file.size ||
      head.ContentType !== file.mimeType ||
      head.ETag?.replaceAll('"', '') !== file.etag
    )
      return 'UNSAFE';
    const tags = await this.client.send(new GetObjectTaggingCommand(input));
    const verdict = tags.TagSet?.find(
      (tag) => tag.Key === 'GuardDutyMalwareScanStatus',
    )?.Value;
    return verdict === 'NO_THREATS_FOUND'
      ? 'CLEAN'
      : verdict
        ? 'UNSAFE'
        : 'PENDING';
  }

  async download(file: ApplicationDocumentFile): Promise<StreamableFile> {
    if ((await this.evidence(file)) !== 'CLEAN')
      throw new ServiceUnavailableException('Document is not available');
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.storageKey,
        VersionId: file.versionId ?? undefined,
        ExpectedBucketOwner: this.config.account,
      }),
    );
    if (!(result.Body instanceof Readable))
      throw new ServiceUnavailableException(
        'Document storage did not return a stream',
      );
    const extension =
      file.mimeType === 'application/pdf'
        ? 'pdf'
        : file.mimeType === 'image/png'
          ? 'png'
          : 'jpg';
    return new StreamableFile(result.Body, {
      type: file.mimeType,
      length: file.size,
      disposition: `attachment; filename="document.${extension}"`,
    });
  }
}
