import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApplicationDocumentType } from '../../generated/prisma/enums';

export class DocumentApplicationParamsDto {
  @IsUUID('4')
  applicationId!: string;
}

export class DocumentRequestParamsDto extends DocumentApplicationParamsDto {
  @IsUUID('4')
  requestId!: string;
}

export class DocumentFileParamsDto extends DocumentApplicationParamsDto {
  @IsUUID('4')
  documentId!: string;
}

export class DocumentRequestInputDto {
  @IsEnum(ApplicationDocumentType)
  type!: ApplicationDocumentType;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
      : value,
  )
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[\p{L}\p{N} .,'()&+/-]+$/u)
  customLabel?: string;
}

export class CreateDocumentRequestsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DocumentRequestInputDto)
  requests!: DocumentRequestInputDto[];
}

export class UploadDocumentBodyDto {}

export class ReviewDocumentDto {
  @IsEnum({ REVIEWED: 'REVIEWED' })
  status!: 'REVIEWED';
}
