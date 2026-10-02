import type {
  ApplicationDocumentType,
  ApplicationDocumentState,
} from '../../generated/prisma/enums';

export class DocumentResponseDto {
  constructor(
    readonly id: string,
    readonly requestId: string,
    readonly state: ApplicationDocumentState,
    readonly mimeType: string,
    readonly size: number,
    readonly createdAt: Date,
    readonly availableAt: Date | null,
    readonly reviewedAt: Date | null,
    readonly canDownload: boolean,
    readonly canReview: boolean,
  ) {}
}

export class DocumentRequestResponseDto {
  constructor(
    readonly id: string,
    readonly applicationId: string,
    readonly type: ApplicationDocumentType,
    readonly customLabel: string | null,
    readonly round: number,
    readonly requestedAt: Date,
    readonly supersededAt: Date | null,
    readonly status:
      | 'UPLOAD_REQUIRED'
      | 'PROCESSING'
      | 'RECEIVED'
      | 'REVIEWED'
      | 'SUPERSEDED',
    readonly canUpload: boolean,
    readonly canRequestReplacement: boolean,
    readonly documents: DocumentResponseDto[],
  ) {}
}
