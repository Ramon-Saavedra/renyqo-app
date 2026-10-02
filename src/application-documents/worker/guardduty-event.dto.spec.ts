import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ApplicationDocumentConfigService } from '../application-document-config.service';
import { parseGuardDutyEvent } from './guardduty-event.dto';

describe('GuardDuty event validation', () => {
  const config = new ApplicationDocumentConfigService(
    new ConfigService({
      DOCUMENTS_S3_BUCKET: 'renyqo-documents-test',
      DOCUMENTS_AWS_ACCOUNT_ID: '111122223333',
      DOCUMENTS_GUARDDUTY_PLAN_ARN:
        'arn:aws:guardduty:eu-central-1:111122223333:malware-protection-plan/test',
    }),
  );
  const event = () => ({
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
        eTag: '"etag"',
        s3Throttled: false,
      },
      scanResultDetails: {
        scanResultStatus: 'NO_THREATS_FOUND',
        threats: null,
        statusReasons: null,
      },
    },
  });

  it('accepts only the configured AWS source, account, region, plan and versioned bucket', () => {
    const input = event();
    expect(parseGuardDutyEvent(JSON.stringify(input), config)).toEqual({
      bucket: config.bucket,
      key: input.detail.s3ObjectDetails.objectKey,
      versionId: 'version-1',
      etag: 'etag',
      occurredAt: new Date(input.time),
      verdict: 'COMPLETED/NO_THREATS_FOUND',
      clean: true,
    });
  });

  it.each([
    { source: 'custom.application' },
    { account: '999988887777' },
    { region: 'us-east-1' },
    { resources: ['arn:other'] },
    { resources: [] },
    { time: 'invalid' },
    { version: '1' },
    { id: 'not-an-id' },
    { 'detail-type': 'unknown' },
    { detail: null },
  ])('rejects an untrusted envelope %j', (overrides) => {
    expect(() =>
      parseGuardDutyEvent(JSON.stringify({ ...event(), ...overrides }), config),
    ).toThrow();
  });

  it.each([
    { bucketName: 'other' },
    { versionId: 'null' },
    { versionId: '' },
    { objectKey: '../profile' },
    { eTag: '' },
  ])('rejects invalid object identity %j', (overrides) => {
    const input = event();
    Object.assign(input.detail.s3ObjectDetails, overrides);
    expect(() => parseGuardDutyEvent(JSON.stringify(input), config)).toThrow();
  });

  it.each([
    ['COMPLETED', 'THREATS_FOUND'],
    ['SKIPPED', 'UNSUPPORTED'],
    ['SKIPPED', 'ACCESS_DENIED'],
    ['FAILED', 'FAILED'],
    ['FAILED', 'NO_THREATS_FOUND'],
  ])('never accepts %s/%s as clean', (status, result) => {
    const input = event();
    input.detail.scanStatus = status;
    input.detail.scanResultDetails.scanResultStatus = result;
    expect(parseGuardDutyEvent(JSON.stringify(input), config).clean).toBe(
      false,
    );
  });

  it('accepts explicit post-scan tagging failures as unsafe', () => {
    const input = event();
    const failure = {
      ...input,
      'detail-type': 'GuardDuty Malware Protection Post Scan Action Failed',
      detail: {
        schemaVersion: '1.0',
        s3ObjectDetails: input.detail.s3ObjectDetails,
        postScanActions: [
          { actionType: 'TAGGING', failureReason: 'ACCESS_DENIED' },
        ],
      },
    };
    expect(parseGuardDutyEvent(JSON.stringify(failure), config)).toEqual(
      expect.objectContaining({ clean: false, verdict: 'TAGGING_FAILED' }),
    );
    expect(() =>
      parseGuardDutyEvent(
        JSON.stringify({
          ...failure,
          detail: { ...failure.detail, postScanActions: [] },
        }),
        config,
      ),
    ).toThrow();
  });

  it.each(['null', '[]', '{}', '{invalid'])(
    'rejects malformed deliveries (%s)',
    (value) => {
      expect(() => parseGuardDutyEvent(value, config)).toThrow();
    },
  );
});
