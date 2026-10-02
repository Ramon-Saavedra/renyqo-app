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
        return requests.map((request) =>
          this.toDto(
            request,
            this.access.canMutate(application) && audience === 'applicant',
            this.access.canMutate(application) && audience === 'provider',
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
        const previous = await tx.applicationDocumentRequest.findFirst({
          where: { applicationId, logicalKey: key },
          orderBy: { round: 'desc' },
        });
        if (previous)
          throw new ConflictException(
            'A request for this document already exists; use a replacement round',
          );
        responses.push(
          this.toDto(
            await this.append(tx, applicationId, input.type, label, key, 1),
            false,
          ),
        );
      }
      return responses;
    });
  }

  replace(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<DocumentRequestResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'provider');
      const request = await tx.applicationDocumentRequest.findFirst({
        where: { id: requestId, applicationId },
        include: { currentFile: true },
      });
      if (!request) throw new NotFoundException('Document request not found');
      if (request.supersededAt)
        throw new ConflictException('Document request is already superseded');
      await tx.applicationDocumentRequest.update({
        where: { id: requestId },
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
      canReview &&
        file.state === ApplicationDocumentState.AVAILABLE &&
        file.reviewedAt === null,
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
    const status = request.supersededAt
      ? 'SUPERSEDED'
      : file?.state === ApplicationDocumentState.AVAILABLE
        ? file.reviewedAt
          ? 'REVIEWED'
          : 'RECEIVED'
        : file?.state === ApplicationDocumentState.PROCESSING
          ? 'PROCESSING'
          : 'UPLOAD_REQUIRED';
    return new DocumentRequestResponseDto(
      request.id,
      request.applicationId,
      request.type,
      request.customLabel,
      request.round,
      request.requestedAt,
      request.supersededAt,
      status,
      canMutate &&
        !request.supersededAt &&
        (!file ||
          (file.state === ApplicationDocumentState.FAILED &&
            !file.availableAt)),
      providerCanMutate && !request.supersededAt,
      request.files.map((item) =>
        this.fileDto(
          item,
          providerCanMutate &&
            !request.supersededAt &&
            item.id === request.currentFileId,
        ),
      ),
    );
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
