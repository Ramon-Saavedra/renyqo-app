import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { VerificationRequirementState } from '../../generated/prisma/enums';
import { ReadModelPageQueryDto } from '../../application-read-models/dto/read-model-input.dto';
import {
  DocumentApplicationParamsDto,
  DocumentRequestInputDto,
} from './document-input.dto';
import type { VerificationCommand } from '../verification-requirement.policy';

export class VerificationItemDto extends DocumentRequestInputDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  subjectId?: string;
}

export class VerificationCommandDto {
  @IsIn(['REQUEST', 'CANCEL', 'REPLACE', 'DECIDE'])
  operation!: VerificationCommand['operation'];

  @ValidateIf(
    (object: VerificationCommandDto) => object.operation === 'REQUEST',
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VerificationItemDto)
  items?: VerificationItemDto[];

  @ValidateIf(
    (object: VerificationCommandDto) => object.operation !== 'REQUEST',
  )
  @IsUUID('4')
  requestId?: string;

  @ValidateIf(
    (object: VerificationCommandDto) => object.operation !== 'REQUEST',
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedRevision?: number;

  @ValidateIf(
    (object: VerificationCommandDto, value: unknown) =>
      object.operation === 'DECIDE' && value !== null,
  )
  @IsUUID('4')
  evidenceFileId?: string | null;

  @ValidateIf(
    (object: VerificationCommandDto, value: unknown) =>
      object.operation === 'DECIDE' && value !== null,
  )
  @IsUUID('4')
  expectedDecisionId?: string | null;

  @ValidateIf((object: VerificationCommandDto) => object.operation === 'DECIDE')
  @IsIn(['SATISFIED', 'NOT_SATISFIED', 'WAIVED'])
  decision?: 'SATISFIED' | 'NOT_SATISFIED' | 'WAIVED';

  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

function hasDecisionInput(dto: VerificationCommandDto) {
  return (
    dto.evidenceFileId !== undefined ||
    dto.expectedDecisionId !== undefined ||
    dto.decision !== undefined ||
    dto.reason !== undefined
  );
}

function decisionReason(
  outcome: 'SATISFIED' | 'NOT_SATISFIED' | 'WAIVED',
  value: string | null | undefined,
) {
  if (value === undefined || value === null) {
    if (outcome === 'NOT_SATISFIED')
      throw new BadRequestException('NOT_SATISFIED requires a reason');
    return null;
  }
  const reason = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!reason || reason.length > 500)
    throw new BadRequestException('Decision reason is invalid');
  if (outcome === 'SATISFIED')
    throw new BadRequestException('SATISFIED does not accept a reason');
  return reason;
}

export function verificationCommand(
  dto: VerificationCommandDto,
): VerificationCommand {
  if (dto.operation !== 'DECIDE' && hasDecisionInput(dto))
    throw new BadRequestException(
      'Only DECIDE accepts a verification decision',
    );
  if (dto.operation === 'REQUEST') {
    if (
      dto.requestId !== undefined ||
      dto.expectedRevision !== undefined ||
      !dto.items
    )
      throw new BadRequestException('REQUEST accepts only operation and items');
    return { operation: 'REQUEST', items: dto.items };
  }
  if (
    dto.items !== undefined ||
    !dto.requestId ||
    dto.expectedRevision === undefined
  )
    throw new BadRequestException(
      'CANCEL, REPLACE and DECIDE require requestId and expectedRevision',
    );
  if (dto.operation === 'DECIDE') {
    if (!dto.decision || dto.evidenceFileId === undefined)
      throw new BadRequestException(
        'DECIDE requires decision and evidenceFileId',
      );
    if (dto.expectedDecisionId === undefined)
      throw new BadRequestException('DECIDE requires expectedDecisionId');
    if (dto.decision !== 'WAIVED' && !dto.evidenceFileId)
      throw new BadRequestException(
        'SATISFIED and NOT_SATISFIED require evidenceFileId',
      );
    return {
      operation: 'DECIDE',
      requestId: dto.requestId,
      expectedRevision: dto.expectedRevision,
      evidenceFileId: dto.evidenceFileId,
      expectedDecisionId: dto.expectedDecisionId,
      decision: dto.decision,
      reason: decisionReason(dto.decision, dto.reason),
    };
  }
  return {
    operation: dto.operation,
    requestId: dto.requestId,
    expectedRevision: dto.expectedRevision,
  };
}

export class VerificationSubjectParamsDto extends DocumentApplicationParamsDto {
  @IsUUID('4') subjectKey!: string;
}

export class HouseholdSubjectDto {
  @IsString() @MaxLength(100) displayLabel!: string;
}

export class OutstandingRequirementsQueryDto extends ReadModelPageQueryDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID('4')
  subjectId?: string;
}

export class ProviderRequirementsQueryDto extends OutstandingRequirementsQueryDto {
  @IsIn([...Object.values(VerificationRequirementState), 'ALL'])
  lifecycleState: VerificationRequirementState | 'ALL' = 'OPEN';
}
