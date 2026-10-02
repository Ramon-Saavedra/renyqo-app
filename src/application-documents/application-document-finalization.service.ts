import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationActivityType,
  ApplicationDocumentState,
} from '../generated/prisma/enums';
import type {
  ApplicationDocumentFile,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ApplicationDocumentAccessService } from './application-document-access.service';
import { ApplicationDocumentActivityService } from './application-document-activity.service';
import { ApplicationDocumentStorageService } from './application-document-storage.service';
export type DocumentScanVerdict = {
  bucket: string;
  key: string;
  versionId: string;
  etag: string;
  occurredAt: Date;
  verdict: string;
  clean: boolean;
};

@Injectable()
export class ApplicationDocumentFinalizationService {
  private readonly logger = new Logger(
    ApplicationDocumentFinalizationService.name,
  );
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationDocumentAccessService,
    private readonly activity: ApplicationDocumentActivityService,
    private readonly storage: ApplicationDocumentStorageService,
  ) {}

  async process(verdict: DocumentScanVerdict): Promise<void> {
    const file = await this.prisma.applicationDocumentFile.findUnique({
      where: { storageKey: verdict.key },
    });
    if (!file || file.bucket !== verdict.bucket) return;
    if (!file.versionId && file.state === ApplicationDocumentState.PROCESSING)
      throw new Error('Upload version is not recorded yet');
    if (
      file.versionId !== verdict.versionId ||
      verdict.occurredAt.getTime() < file.createdAt.getTime() - 1000 ||
      verdict.occurredAt.getTime() > Date.now() + 60_000
    ) {
      this.logger.warn({ signal: 'STALE_SCAN_EVENT', documentId: file.id });
      return;
    }
    const evidence =
      verdict.clean &&
      file.state === ApplicationDocumentState.PROCESSING &&
      Date.now() < file.expiresAt.getTime()
        ? await this.storage.evidence(file)
        : undefined;
    await this.finalize(file.id, verdict, evidence);
  }

  async recover(file: ApplicationDocumentFile): Promise<void> {
    if (
      file.state !== ApplicationDocumentState.PROCESSING ||
      file.recoverAfter.getTime() > Date.now()
    )
      return;
    const evidence =
      file.versionId && Date.now() < file.expiresAt.getTime()
        ? await this.storage.evidence(file)
        : undefined;
    const verdict: DocumentScanVerdict | undefined =
      evidence === 'CLEAN'
        ? {
            bucket: file.bucket,
            key: file.storageKey,
            versionId: file.versionId ?? '',
            etag: file.etag ?? '',
            occurredAt: new Date(),
            verdict: 'COMPLETED/NO_THREATS_FOUND',
            clean: true,
          }
        : evidence === 'UNSAFE'
          ? {
              bucket: file.bucket,
              key: file.storageKey,
              versionId: file.versionId ?? '',
              etag: file.etag ?? '',
              occurredAt: new Date(),
              verdict: 'RECOVERY_UNSAFE',
              clean: false,
            }
          : undefined;
    await this.finalize(file.id, verdict, evidence);
  }

  private async finalize(
    id: string,
    verdict: DocumentScanVerdict | undefined,
    evidence: 'CLEAN' | 'PENDING' | 'UNSAFE' | undefined,
  ): Promise<void> {
    let retry = false;
    await runSerializableTransaction(this.prisma, async (tx) => {
      retry = false;
      const reference = await tx.applicationDocumentFile.findUnique({
        where: { id },
        include: { request: true },
      });
      if (!reference) return;
      const application = await this.access.lock(
        tx,
        reference.request.applicationId,
      );
      const file = await tx.applicationDocumentFile.findUnique({
        where: { id },
        include: { request: true },
      });
      if (!file) return;
      if (
        verdict &&
        (file.versionId !== verdict.versionId ||
          file.bucket !== verdict.bucket ||
          file.storageKey !== verdict.key)
      )
        return;
      if (
        verdict &&
        (file.etag !== verdict.etag ||
          (file.scanVerdict && file.scanVerdict !== verdict.verdict))
      ) {
        await this.fail(tx, file.id, 'CONTRADICTORY_VERDICT');
        this.logger.error({ signal: 'CONTRADICTORY_VERDICT', documentId: id });
        return;
      }
      if ((verdict && !verdict.clean) || evidence === 'UNSAFE') {
        await this.fail(
          tx,
          id,
          verdict?.verdict === 'TAGGING_FAILED'
            ? 'TAGGING_FAILED'
            : 'SCAN_FAILED',
          verdict?.verdict,
        );
        this.logger.error({
          signal:
            verdict?.verdict === 'TAGGING_FAILED'
              ? 'TAGGING_FAILED'
              : 'SCAN_FAILED',
          documentId: id,
        });
        return;
      }
      if (file.request.supersededAt || file.request.currentFileId !== file.id) {
        if (file.state === ApplicationDocumentState.PROCESSING)
          await this.fail(tx, file.id, 'SUPERSEDED');
        return;
      }
      if (file.state !== ApplicationDocumentState.PROCESSING) return;
      if (Date.now() >= file.expiresAt.getTime()) {
        await this.fail(tx, id, 'PROCESSING_TIMEOUT');
        this.logger.error({ signal: 'PROCESSING_TIMEOUT', documentId: id });
        return;
      }
      if (!this.access.canMutate(application)) {
        await this.fail(tx, id, 'APPLICATION_UNAVAILABLE');
        return;
      }
      if (!verdict?.clean || evidence !== 'CLEAN') {
        await tx.applicationDocumentFile.update({
          where: { id },
          data: {
            scanVerdict: verdict?.verdict,
            recoverAfter: new Date(Date.now() + 60_000),
          },
        });
        retry = verdict?.clean === true;
        return;
      }
      await tx.applicationDocumentFile.update({
        where: { id },
        data: {
          state: ApplicationDocumentState.AVAILABLE,
          scanVerdict: verdict.verdict,
          availableAt: new Date(),
        },
      });
      await this.activity.append(
        tx,
        file.request.applicationId,
        file.requestId,
        file.request.type,
        ApplicationActivityType.DOCUMENT_UPLOADED,
      );
      this.logger.log({
        signal: 'DOCUMENT_FINALIZED',
        documentId: id,
        processingMs: Date.now() - file.createdAt.getTime(),
      });
    });
    if (retry) throw new Error('Clean scan tag is not confirmed yet');
  }

  private fail(
    tx: Prisma.TransactionClient,
    id: string,
    failureReason: string,
    scanVerdict?: string,
  ): Promise<ApplicationDocumentFile> {
    return tx.applicationDocumentFile.update({
      where: { id },
      data: {
        state: ApplicationDocumentState.FAILED,
        failureReason,
        scanVerdict,
      },
    });
  }
}
