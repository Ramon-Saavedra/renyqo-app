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
  @IsIn(['REQUEST', 'CANCEL', 'REPLACE'])
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
}

export function verificationCommand(
  dto: VerificationCommandDto,
): VerificationCommand {
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
      'CANCEL and REPLACE require requestId and expectedRevision',
    );
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
