import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { DocumentQueueService } from './document-queue.service';
import { ApplicationDocumentConfigService } from '../application-document-config.service';
import { ApplicationDocumentFinalizationService } from '../application-document-finalization.service';
import { DocumentRecoveryService } from './document-recovery.service';

const mockSend = jest.fn<(command: unknown) => Promise<unknown>>();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  ...jest.requireActual<typeof import('@aws-sdk/client-sqs')>(
    '@aws-sdk/client-sqs',
  ),
  SQSClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
}));

describe('Document queue acknowledgement', () => {
  const config = new ApplicationDocumentConfigService(
    new ConfigService({
      DATABASE_URL: 'postgresql://localhost/renyqo_test',
      DOCUMENTS_S3_BUCKET: 'renyqo-documents-test',
      DOCUMENTS_AWS_ACCOUNT_ID: '111122223333',
      DOCUMENTS_GUARDDUTY_PLAN_ARN:
        'arn:aws:guardduty:eu-central-1:111122223333:malware-protection-plan/test',
      DOCUMENTS_SCAN_QUEUE_URL:
        'https://sqs.eu-central-1.amazonaws.com/111122223333/document-verdicts',
    }),
  );
  let queue: DocumentQueueService;
  const processVerdict = jest.fn<(input: unknown) => Promise<void>>();
  const recover = jest.fn<() => Promise<void>>();
  const message = () => ({
    MessageId: randomUUID(),
    ReceiptHandle: 'receipt',
    Body: JSON.stringify({
      version: '0',
      id: randomUUID(),
      source: 'aws.guardduty',
      account: config.account,
      region: config.region,
      resources: [config.planArn],
      time: new Date().toISOString(),
      'detail-type': 'GuardDuty Malware Protection Object Scan Result',
      detail: {
        schemaVersion: '1.0',
        resourceType: 'S3_OBJECT',
        scanStatus: 'COMPLETED',
        s3ObjectDetails: {
          bucketName: config.bucket,
          objectKey: `documents/${randomUUID()}/${randomUUID()}`,
          versionId: 'version-1',
          eTag: 'etag',
        },
        scanResultDetails: { scanResultStatus: 'NO_THREATS_FOUND' },
      },
    }),
  });

  beforeEach(async () => {
    mockSend.mockReset();
    processVerdict.mockReset().mockResolvedValue(undefined);
    recover.mockReset().mockResolvedValue(undefined);
    mockDestroy.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        DocumentQueueService,
        { provide: ApplicationDocumentConfigService, useValue: config },
        {
          provide: ApplicationDocumentFinalizationService,
          useValue: { process: processVerdict },
        },
        { provide: DocumentRecoveryService, useValue: { run: recover } },
      ],
    }).compile();
    queue = module.get(DocumentQueueService);
  });

  it('acknowledges only after successful finalization', async () => {
    expect(jest.mocked(SQSClient)).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHandler: {
          connectionTimeout: 3000,
          requestTimeout: 25000,
          throwOnRequestTimeout: true,
        },
      }),
    );
    mockSend.mockImplementation((command) => {
      expect(processVerdict).toHaveBeenCalledTimes(1);
      expect(command).toBeInstanceOf(DeleteMessageCommand);
      return Promise.resolve({});
    });
    await queue.consume(message());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('retains deliveries when finalization needs a retry', async () => {
    processVerdict.mockRejectedValue(
      new Error('Missing tag or transaction failure'),
    );
    await queue.consume(message());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('retains malformed and forged messages for the consumer DLQ', async () => {
    await queue.consume({ Body: '{}', ReceiptHandle: 'receipt' });
    await queue.consume({ Body: message().Body });
    expect(processVerdict).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('recovers overdue attempts even when SQS is unavailable, and drains on shutdown', async () => {
    mockSend.mockImplementation((command) => {
      expect(command).toBeInstanceOf(ReceiveMessageCommand);
      return Promise.resolve().then(() => {
        queue.stop();
        throw new Error('Queue unavailable');
      });
    });
    await queue.run();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
