import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ApplicationDocumentFile,
  ApplicationDocumentRequest,
} from '../generated/prisma/client';
import { ApplicationDocumentState } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationRequirementService } from './verification-requirement.service';
import {
  ApplicationDocumentAccessService,
  type DocumentAudience,
} from './application-document-access.service';
import { DocumentRequestInputDto } from './dto/document-input.dto';
import {
  documentCancelCapability,
  documentReplacementAllowed,
  documentRequestCapabilities,
  documentRequestStatus,
  documentReviewRequired,
} from './application-document.policy';
import {
  DocumentRequestResponseDto,
  DocumentResponseDto,
} from './dto/document-response.dto';

@Injectable()
export class ApplicationDocumentRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationDocumentAccessService,
    private readonly requirements: VerificationRequirementService,
  ) {}

  list(
    applicationId: string,
    userId: string,
    audience: DocumentAudience,
  ): Promise<DocumentRequestResponseDto[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          audience,
        );
        const requests = await tx.applicationDocumentRequest.findMany({
          where: { applicationId },
          include: {
            files: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        });
        const mutable = this.access.canMutate(application);
        return requests.map((request) =>
          this.toDto(
            request,
            mutable && audience === 'applicant',
            mutable && audience === 'provider',
          ),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async create(
    applicationId: string,
    userId: string,
    inputs: DocumentRequestInputDto[],
  ): Promise<DocumentRequestResponseDto[]> {
    const result = await this.requirements.execute(applicationId, userId, {
      operation: 'REQUEST',
      items: inputs,
    });
    return this.projectResult(
      applicationId,
      userId,
      result.requirements.map((r) => r.id),
    );
  }
  async cancel(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<DocumentRequestResponseDto> {
    await this.requirements.execute(applicationId, userId, {
      operation: 'CANCEL',
      requestId,
    });
    return (await this.projectResult(applicationId, userId, [requestId]))[0];
  }
  async replace(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<DocumentRequestResponseDto> {
    const result = await this.requirements.execute(applicationId, userId, {
      operation: 'REPLACE',
      requestId,
    });
    return (
      await this.projectResult(applicationId, userId, [
        result.requirements[1].id,
      ])
    )[0];
  }
  private projectResult(applicationId: string, userId: string, ids: string[]) {
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          userId,
          'provider',
        );
        const mutable = this.access.canMutate(application);
        const rows = await tx.applicationDocumentRequest.findMany({
          where: { id: { in: ids }, applicationId },
          include: {
            files: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          },
        });
        return ids.map((id) => {
          const row = rows.find((r) => r.id === id);
          if (!row) throw new NotFoundException('Document request not found');
          return this.toDto(row, false, mutable);
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  fileDto(
    file: ApplicationDocumentFile,
    canReview = false,
  ): DocumentResponseDto {
    return new DocumentResponseDto(
      file.id,
      file.requestId,
      file.state,
      file.mimeType,
      file.size,
      file.createdAt,
      file.availableAt,
      file.reviewedAt,
      file.state === ApplicationDocumentState.AVAILABLE,
      canReview && documentReviewRequired(file),
    );
  }

  private toDto(
    request: ApplicationDocumentRequest & { files: ApplicationDocumentFile[] },
    canMutate: boolean,
    providerCanMutate = false,
  ): DocumentRequestResponseDto {
    const file = request.files.find(
      (item) => item.id === request.currentFileId,
    );
    const fileState = file
      ? {
          state: file.state,
          availableAt: file.availableAt,
          reviewedAt: file.reviewedAt,
        }
      : null;
    const capabilities = documentRequestCapabilities(
      request.closedAt,
      fileState,
      canMutate,
    );
    return new DocumentRequestResponseDto(
      request.id,
      request.applicationId,
      request.type,
      request.customLabel,
      request.round,
      request.requestedAt,
      request.supersededAt,
      documentRequestStatus(
        request.closedAt,
        fileState,
        request.lifecycleState,
      ),
      capabilities.canUpload,
      documentCancelCapability(
        request.closedAt,
        fileState,
        providerCanMutate,
        'provider',
      ),
      documentReplacementAllowed(
        request.closedAt,
        fileState,
        providerCanMutate,
        'provider',
      ),
      request.files.map((item) =>
        this.fileDto(
          item,
          providerCanMutate &&
            !request.closedAt &&
            item.id === request.currentFileId,
        ),
      ),
      request.closedAt,
    );
  }
}
