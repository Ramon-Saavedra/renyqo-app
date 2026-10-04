import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ApplicationDocumentFile,
  ApplicationDocumentRequest,
  Prisma,
} from '../generated/prisma/client';
import {
  ApplicationActivityType,
  ApplicationDocumentState,
  ApplicationDocumentType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { createHash } from 'node:crypto';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import {
  ApplicationDocumentAccessService,
  type DocumentAudience,
} from './application-document-access.service';
import { ApplicationDocumentActivityService } from './application-document-activity.service';
import { DocumentRequestInputDto } from './dto/document-input.dto';
import {
  documentCancelCapability,
  documentCancellationAllowed,
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
    private readonly activity: ApplicationDocumentActivityService,
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

  create(
    applicationId: string,
    userId: string,
    inputs: DocumentRequestInputDto[],
  ): Promise<DocumentRequestResponseDto[]> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'provider');
      const responses: DocumentRequestResponseDto[] = [];
      for (const input of inputs) {
        const { label, key } = this.identity(input);
        const active = await tx.applicationDocumentRequest.findFirst({
          where: { applicationId, logicalKey: key, supersededAt: null },
        });
        if (active)
          throw new ConflictException(
            'An active request for this document already exists',
          );
        const latest = await tx.applicationDocumentRequest.findFirst({
          where: { applicationId, logicalKey: key },
          orderBy: { round: 'desc' },
          select: { round: true },
        });
        const round = latest ? latest.round + 1 : 1;
        responses.push(
          this.toDto(
            await this.append(tx, applicationId, input.type, label, key, round),
            false,
            true,
          ),
        );
      }
      return responses;
    });
  }

  cancel(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<DocumentRequestResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'provider');
      const request = await this.loadRequest(tx, requestId, applicationId);
      if (
        !documentCancellationAllowed(
          request.supersededAt,
          request.currentFile,
          true,
        )
      )
        throw new ConflictException(
          'Document request cannot be cancelled in its current state',
        );
      await this.supersedeCurrent(tx, request);
      await this.activity.append(
        tx,
        applicationId,
        request.id,
        request.type,
        ApplicationActivityType.DOCUMENT_REQUEST_CANCELLED,
      );
      return this.toDto(
        await this.loadRequestWithFiles(tx, requestId, applicationId),
        false,
        true,
      );
    });
  }

  replace(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<DocumentRequestResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'provider');
      const request = await this.loadRequest(tx, requestId, applicationId);
      if (
        !documentReplacementAllowed(
          request.supersededAt,
          request.currentFile,
          true,
          'provider',
        )
      )
        throw new ConflictException(
          'Document replacement requires a received document',
        );
      await this.supersedeCurrent(tx, request);
      return this.toDto(
        await this.append(
          tx,
          applicationId,
          request.type,
          request.customLabel,
          request.logicalKey,
          request.round + 1,
        ),
        false,
        true,
      );
    });
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
      request.supersededAt,
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
      documentRequestStatus(request.supersededAt, fileState),
      capabilities.canUpload,
      documentCancelCapability(
        request.supersededAt,
        fileState,
        providerCanMutate,
        'provider',
      ),
      documentReplacementAllowed(
        request.supersededAt,
        fileState,
        providerCanMutate,
        'provider',
      ),
      request.files.map((item) =>
        this.fileDto(
          item,
          providerCanMutate &&
            !request.supersededAt &&
            item.id === request.currentFileId &&
            capabilities.canReview,
        ),
      ),
    );
  }

  private async loadRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
    applicationId: string,
  ) {
    const request = await tx.applicationDocumentRequest.findFirst({
      where: { id: requestId, applicationId },
      include: { currentFile: true },
    });
    if (!request) throw new NotFoundException('Document request not found');
    if (request.supersededAt)
      throw new ConflictException('Document request is already superseded');
    return request;
  }

  private loadRequestWithFiles(
    tx: Prisma.TransactionClient,
    requestId: string,
    applicationId: string,
  ) {
    return tx.applicationDocumentRequest.findFirstOrThrow({
      where: { id: requestId, applicationId },
      include: {
        files: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
  }

  private async supersedeCurrent(
    tx: Prisma.TransactionClient,
    request: {
      id: string;
      currentFile: ApplicationDocumentFile | null;
    },
  ): Promise<void> {
    await tx.applicationDocumentRequest.update({
      where: { id: request.id },
      data: { supersededAt: new Date() },
    });
    if (request.currentFile?.state === ApplicationDocumentState.PROCESSING)
      await tx.applicationDocumentFile.update({
        where: { id: request.currentFile.id },
        data: {
          state: ApplicationDocumentState.FAILED,
          failureReason: 'SUPERSEDED',
        },
      });
  }

  private identity(input: DocumentRequestInputDto): {
    label: string | null;
    key: string;
  } {
    if (input.type !== ApplicationDocumentType.OTHER) {
      if (input.customLabel !== undefined)
        throw new BadRequestException(
          'customLabel is only supported for OTHER',
        );
      return { label: null, key: input.type };
    }
    const label = input.customLabel
      ?.normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ');
    if (
      !label ||
      label.length > 100 ||
      !/^[\p{L}\p{N} .,'()&+/-]+$/u.test(label)
    )
      throw new BadRequestException('OTHER requires a valid customLabel');
    const normalizedLabel = label.toLocaleLowerCase('de-DE');
    return {
      label,
      key: `OTHER:${createHash('sha256').update(normalizedLabel).digest('hex')}`,
    };
  }

  private async append(
    tx: Prisma.TransactionClient,
    applicationId: string,
    type: ApplicationDocumentType,
    customLabel: string | null,
    logicalKey: string,
    round: number,
  ): Promise<
    ApplicationDocumentRequest & { files: ApplicationDocumentFile[] }
  > {
    const request = await tx.applicationDocumentRequest.create({
      data: { applicationId, type, customLabel, logicalKey, round },
      include: { files: true },
    });
    await this.activity.append(
      tx,
      applicationId,
      request.id,
      type,
      ApplicationActivityType.DOCUMENT_REQUESTED,
    );
    return request;
  }
}
