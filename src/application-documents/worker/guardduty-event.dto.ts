import { Type, plainToInstance } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { ApplicationDocumentConfigService } from '../application-document-config.service';

class ScanObjectDto {
  @IsString() @MaxLength(63) bucketName!: string;
  @IsString() @MaxLength(1024) objectKey!: string;
  @IsString() @MaxLength(1024) versionId!: string;
  @IsString() @MaxLength(128) eTag!: string;
}

class ScanResultDto {
  @IsIn([
    'NO_THREATS_FOUND',
    'THREATS_FOUND',
    'UNSUPPORTED',
    'ACCESS_DENIED',
    'FAILED',
  ])
  scanResultStatus!: string;
}

class PostScanActionDto {
  @IsIn(['TAGGING']) actionType!: string;
  @IsIn(['ACCESS_DENIED', 'MAX_TAG_LIMIT_EXCEEDED']) failureReason!: string;
}

class ScanDetailDto {
  @IsIn(['1.0']) schemaVersion!: string;
  @ValidateNested() @Type(() => ScanObjectDto) s3ObjectDetails!: ScanObjectDto;
  @IsOptional() @IsIn(['COMPLETED', 'FAILED', 'SKIPPED']) scanStatus?: string;
  @IsOptional() @IsIn(['S3_OBJECT']) resourceType?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => ScanResultDto)
  scanResultDetails?: ScanResultDto;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PostScanActionDto)
  postScanActions?: PostScanActionDto[];
}

export class GuardDutyEventDto {
  @IsIn(['0']) version!: string;
  @IsUUID() id!: string;
  @IsIn(['aws.guardduty']) source!: string;
  @Matches(/^\d{12}$/) account!: string;
  @IsIn(['eu-central-1']) region!: string;
  @IsISO8601() time!: string;
  @IsIn([
    'GuardDuty Malware Protection Object Scan Result',
    'GuardDuty Malware Protection Post Scan Action Failed',
  ])
  ['detail-type']!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @IsString({ each: true })
  resources!: string[];
  @ValidateNested() @Type(() => ScanDetailDto) detail!: ScanDetailDto;
}

import type { DocumentScanVerdict } from '../application-document-finalization.service';

export function parseGuardDutyEvent(
  body: string,
  config: ApplicationDocumentConfigService,
): DocumentScanVerdict {
  const data: unknown = JSON.parse(body);
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error('Invalid scan event');
  const event = plainToInstance(GuardDutyEventDto, data);
  if (
    validateSync(event, { whitelist: true, forbidUnknownValues: true })
      .length ||
    !event.detail?.s3ObjectDetails ||
    event.account !== config.account ||
    event.region !== config.region ||
    event.resources[0] !== config.planArn
  )
    throw new Error('Untrusted scan event');
  const object = event.detail.s3ObjectDetails;
  if (
    object.bucketName !== config.bucket ||
    !/^documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(object.objectKey) ||
    !object.versionId ||
    object.versionId === 'null' ||
    !object.eTag
  )
    throw new Error('Invalid scan object');
  const taggingFailed =
    event['detail-type'] ===
    'GuardDuty Malware Protection Post Scan Action Failed';
  if (
    taggingFailed
      ? !event.detail.postScanActions?.length
      : !event.detail.scanStatus ||
        !event.detail.scanResultDetails ||
        event.detail.resourceType !== 'S3_OBJECT'
  )
    throw new Error('Incomplete scan verdict');
  const result = event.detail.scanResultDetails?.scanResultStatus;
  return {
    bucket: object.bucketName,
    key: object.objectKey,
    versionId: object.versionId,
    etag: object.eTag.replaceAll('"', ''),
    occurredAt: new Date(event.time),
    verdict: taggingFailed
      ? 'TAGGING_FAILED'
      : `${event.detail.scanStatus}/${result}`,
    clean:
      !taggingFailed &&
      event.detail.scanStatus === 'COMPLETED' &&
      result === 'NO_THREATS_FOUND',
  };
}
