import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  ApplicationDocumentState,
  ApplicationActivityType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import {
  ApplicationDocumentAccessService,
  type DocumentAudience,
} from './application-document-access.service';
import { ApplicationDocumentConfigService } from './application-document-config.service';
import { ApplicationDocumentStorageService } from './application-document-storage.service';
import { ApplicationDocumentRequestService } from './application-document-request.service';
import { ApplicationDocumentActivityService } from './application-document-activity.service';
import { DocumentResponseDto } from './dto/document-response.dto';

@Injectable()
export class ApplicationDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationDocumentAccessService,
    private readonly config: ApplicationDocumentConfigService,
    private readonly storage: ApplicationDocumentStorageService,
    private readonly requests: ApplicationDocumentRequestService,
    private readonly activity: ApplicationDocumentActivityService,
  ) {}

  async authorizeUpload(
    applicationId: string,
    requestId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const application = await this.access.authorize(
        tx,
        applicationId,
        userId,
        'applicant',
      );
      if (!this.access.canMutate(application))
        throw new ConflictException(
          'Documents cannot be changed for this application',
        );
      const request = await tx.applicationDocumentRequest.findFirst({
        where: { id: requestId, applicationId, supersededAt: null },
        include: { currentFile: true },
      });
      if (!request) throw new NotFoundException('Document request not found');
      if (
        request.currentFile &&
        (request.currentFile.state !== ApplicationDocumentState.FAILED ||
          request.currentFile.availableAt)
      )
        throw new ConflictException('This request already has a document');
    });
  }

  async upload(
    applicationId: string,
    requestId: string,
    userId: string,
    input: Express.Multer.File,
  ): Promise<DocumentResponseDto> {
    const bucket = this.config.bucket;
    void this.config.account;
    void this.config.planArn;
    const file = await runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'applicant');
      const request = await tx.applicationDocumentRequest.findFirst({
        where: { id: requestId, applicationId, supersededAt: null },
        include: { currentFile: true },
      });
      if (!request) throw new NotFoundException('Document request not found');
      if (
        request.currentFile &&
        (request.currentFile.state !== ApplicationDocumentState.FAILED ||
          request.currentFile.availableAt)
      )
        throw new ConflictException('This request already has a document');
      const id = randomUUID();
      const now = Date.now();
      const attempt = await tx.applicationDocumentFile.create({
        data: {
          id,
          requestId,
          bucket,
          storageKey: `documents/${randomUUID()}/${id}`,
          checksum: createHash('sha256').update(input.buffer).digest('hex'),
          mimeType: input.mimetype,
          size: input.buffer.length,
          recoverAfter: new Date(now + this.config.recoveryDelayMs),
          expiresAt: new Date(now + this.config.processingTimeoutMs),
        },
      });
      await tx.applicationDocumentRequest.update({
        where: { id: requestId },
        data: { currentFileId: id },
      });
      return attempt;
    });
    let object: { versionId: string; etag: string };
    try {
      object = await this.storage.put(file, input.buffer);
    } catch {
      await this.prisma.applicationDocumentFile.updateMany({
        where: { id: file.id, state: ApplicationDocumentState.PROCESSING },
        data: {
          state: ApplicationDocumentState.FAILED,
          failureReason: 'STORAGE_FAILED',
        },
      });
      throw new ServiceUnavailableException('Document upload failed');
    }
    const saved = await this.prisma.applicationDocumentFile.update({
      where: { id: file.id },
      data: { versionId: object.versionId, etag: object.etag },
    });
    return this.requests.fileDto(saved);
  }

  async download(
    applicationId: string,
    documentId: string,
    userId: string,
    audience: DocumentAudience,
  ): Promise<StreamableFile> {
    const file = await this.prisma.$transaction(async (tx) => {
      await this.access.authorize(tx, applicationId, userId, audience);
      const file = await tx.applicationDocumentFile.findFirst({
        where: {
          id: documentId,
          request: { applicationId },
          state: ApplicationDocumentState.AVAILABLE,
        },
      });
      if (!file) throw new NotFoundException('Available document not found');
      return file;
    });
    const stream = await this.storage.download(file);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.access.lock(tx, applicationId);
        await this.access.authorize(tx, applicationId, userId, audience);
        const current = await tx.applicationDocumentFile.findFirst({
          where: {
            id: documentId,
            state: ApplicationDocumentState.AVAILABLE,
            request: { applicationId },
          },
        });
        if (!current)
          throw new NotFoundException('Available document not found');
      });
      return stream;
    } catch (error) {
      stream.getStream().destroy();
      throw error;
    }
  }

  review(
    applicationId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentResponseDto> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.mutation(tx, applicationId, userId, 'provider');
      const file = await tx.applicationDocumentFile.findFirst({
        where: {
          id: documentId,
          state: ApplicationDocumentState.AVAILABLE,
          request: {
            applicationId,
            supersededAt: null,
            currentFileId: documentId,
          },
        },
        include: { request: true },
      });
      if (!file)
        throw new NotFoundException('Available current document not found');
      if (file.reviewedAt) return this.requests.fileDto(file);
      const reviewed = await tx.applicationDocumentFile.update({
        where: { id: documentId },
        data: { reviewedAt: new Date() },
      });
      await this.activity.append(
        tx,
        applicationId,
        file.requestId,
        file.request.type,
        ApplicationActivityType.DOCUMENT_REVIEWED,
      );
      return this.requests.fileDto(reviewed);
    });
  }
}
