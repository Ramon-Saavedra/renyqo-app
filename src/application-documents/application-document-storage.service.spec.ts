import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { ApplicationDocumentConfigService } from './application-document-config.service';
import { ApplicationDocumentStorageService } from './application-document-storage.service';
import type { ApplicationDocumentFile } from '../generated/prisma/client';
import { ApplicationDocumentState } from '../generated/prisma/enums';

const mockSend = jest.fn<(command: unknown) => Promise<unknown>>();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-s3')>(
    '@aws-sdk/client-s3',
  ),
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
}));

describe('Private document storage', () => {
  const config = new ApplicationDocumentConfigService(
    new ConfigService({
      DOCUMENTS_S3_BUCKET: 'renyqo-documents-test',
      DOCUMENTS_AWS_ACCOUNT_ID: '111122223333',
    }),
  );
  const file: ApplicationDocumentFile = {
    id: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    bucket: config.bucket,
    storageKey: 'documents/opaque/attempt',
    versionId: 'version-1',
    etag: 'etag',
    checksum: 'ab'.repeat(32),
    mimeType: 'application/pdf',
    size: 32,
    state: ApplicationDocumentState.PROCESSING,
    createdAt: new Date(),
    expiresAt: new Date(),
    recoverAfter: new Date(),
    availableAt: null,
    reviewedAt: null,
    scanVerdict: null,
    failureReason: null,
  };
  let storage: ApplicationDocumentStorageService;
  beforeEach(() => {
    mockSend.mockReset();
    storage = new ApplicationDocumentStorageService(config);
  });

  function head(overrides: Record<string, unknown> = {}) {
    return {
      VersionId: file.versionId,
      ETag: '"etag"',
      Metadata: { 'upload-attempt': file.id, sha256: file.checksum },
      ContentType: file.mimeType,
      ContentLength: file.size,
      ...overrides,
    };
  }

  it('writes encrypted immutable bytes with checksum and attempt metadata, without scan tags', async () => {
    expect(jest.mocked(S3Client)).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHandler: {
          connectionTimeout: 3000,
          requestTimeout: 15000,
          throwOnRequestTimeout: true,
        },
      }),
    );
    mockSend.mockResolvedValue({ VersionId: 'version-1', ETag: '"etag"' });
    expect(await storage.put(file, Buffer.alloc(32))).toEqual({
      versionId: 'version-1',
      etag: 'etag',
    });
    const command = mockSend.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    if (!(command instanceof PutObjectCommand))
      throw new Error('Expected object upload');
    expect(command.input).toEqual(
      expect.objectContaining({
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
        ExpectedBucketOwner: config.account,
        Metadata: { 'upload-attempt': file.id, sha256: file.checksum },
      }),
    );
    expect(command.input.Tagging).toBeUndefined();
    expect(command.input.ACL).toBeUndefined();
  });

  it.each([undefined, 'null'])(
    'rejects unversioned storage responses (%s)',
    async (version) => {
      mockSend.mockResolvedValue({ VersionId: version, ETag: 'etag' });
      await expect(storage.put(file, Buffer.alloc(32))).rejects.toThrow(
        'versioned',
      );
    },
  );

  it('reads metadata and the scan tag for the exact immutable version and bucket owner', async () => {
    mockSend.mockResolvedValueOnce(head()).mockResolvedValueOnce({
      TagSet: [
        { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
      ],
    });
    await expect(storage.evidence(file)).resolves.toBe('CLEAN');
    const commands = mockSend.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect(commands[1]).toBeInstanceOf(GetObjectTaggingCommand);
    for (const command of commands) {
      if (
        !(
          command instanceof HeadObjectCommand ||
          command instanceof GetObjectTaggingCommand
        )
      )
        throw new Error('Invalid metadata command');
      expect(command.input).toEqual({
        Bucket: file.bucket,
        Key: file.storageKey,
        VersionId: file.versionId,
        ExpectedBucketOwner: config.account,
      });
    }
  });

  it.each([
    { VersionId: 'other' },
    { ETag: 'other' },
    { Metadata: { 'upload-attempt': 'other', sha256: file.checksum } },
    { Metadata: { 'upload-attempt': file.id, sha256: 'other' } },
    { ContentType: 'text/html' },
    { ContentLength: 33 },
  ])('rejects mismatched storage evidence %j', async (overrides) => {
    mockSend.mockResolvedValue(head(overrides));
    await expect(storage.evidence(file)).resolves.toBe('UNSAFE');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each(['THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'])(
    'blocks download with tag %s',
    async (status) => {
      mockSend.mockResolvedValueOnce(head()).mockResolvedValueOnce({
        TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: status }],
      });
      await expect(storage.download(file)).rejects.toThrow('not available');
      expect(
        mockSend.mock.calls.some(
          ([command]) => command instanceof GetObjectCommand,
        ),
      ).toBe(false);
    },
  );

  it('treats missing tags as pending and propagates storage failures for retry', async () => {
    mockSend
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce({ TagSet: [] });
    await expect(storage.evidence(file)).resolves.toBe('PENDING');
    mockSend.mockRejectedValueOnce(new Error('AWS unavailable'));
    await expect(storage.evidence(file)).rejects.toThrow('AWS unavailable');
  });

  it('streams only clean versions with a safe download filename', async () => {
    mockSend
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce({
        TagSet: [
          { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
        ],
      })
      .mockResolvedValueOnce({ Body: Readable.from(Buffer.from('file')) });
    const stream = await storage.download(file);
    expect(stream.getHeaders().disposition).toBe(
      'attachment; filename="document.pdf"',
    );
    const command = mockSend.mock.calls[2][0];
    if (!(command instanceof GetObjectCommand))
      throw new Error('Expected exact-version download');
    expect(command.input.VersionId).toBe(file.versionId);
  });
});
