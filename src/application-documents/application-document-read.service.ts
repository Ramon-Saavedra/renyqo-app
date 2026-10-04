import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  documentCancelCapability,
  documentReplacementAllowed,
  documentRequestCapabilities,
  documentRequestStatus,
} from './application-document.policy';
import type { AttentionAudience } from '../application-attention/application-pending-action';
import { ApplicationDocumentState } from '../generated/prisma/enums';

@Injectable()
export class ApplicationDocumentReadService {
  summary(
    requests: Awaited<ReturnType<ApplicationDocumentReadService['batch']>>,
    mutable: boolean,
    audience: AttentionAudience,
  ) {
    const currentRequests = requests
      .map((request) => {
        const capabilities = documentRequestCapabilities(
          request.supersededAt,
          request.currentFile,
          mutable,
        );
        return {
          requestId: request.id,
          type: request.type,
          customLabel: request.customLabel,
          status: documentRequestStatus(
            request.supersededAt,
            request.currentFile,
          ),
          documentId: request.currentFile?.id ?? null,
          canDownload:
            request.currentFile?.state === ApplicationDocumentState.AVAILABLE,
          canUpload: audience === 'applicant' && capabilities.canUpload,
          canReview: audience === 'provider' && capabilities.canReview,
          canCancel: documentCancelCapability(
            request.supersededAt,
            request.currentFile,
            mutable,
            audience,
          ),
          canRequestReplacement: documentReplacementAllowed(
            request.supersededAt,
            request.currentFile,
            mutable,
            audience,
          ),
        };
      })
      .sort((a, b) =>
        a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0,
      );
    return {
      canRequestDocuments: audience === 'provider' && mutable,
      counts: {
        requestedCount: currentRequests.length,
        uploadRequiredCount: currentRequests.filter((row) => row.canUpload)
          .length,
        reviewRequiredCount: currentRequests.filter((row) => row.canReview)
          .length,
        processingCount: currentRequests.filter(
          (row) => row.status === 'PROCESSING',
        ).length,
        reviewedCount: currentRequests.filter(
          (row) => row.status === 'REVIEWED',
        ).length,
      },
      currentRequests,
    };
  }
  batch(tx: Prisma.TransactionClient, applicationIds: readonly string[]) {
    return tx.applicationDocumentRequest.findMany({
      where: { applicationId: { in: [...applicationIds] }, supersededAt: null },
      select: {
        id: true,
        applicationId: true,
        type: true,
        customLabel: true,
        requestedAt: true,
        supersededAt: true,
        currentFile: {
          select: {
            id: true,
            state: true,
            availableAt: true,
            reviewedAt: true,
          },
        },
      },
    });
  }

  facts(
    requests: Awaited<ReturnType<ApplicationDocumentReadService['batch']>>,
    mutable: boolean,
  ) {
    return requests.map((request) => ({
      requestId: request.id,
      documentId: request.currentFile?.id ?? null,
      requestedAt: request.requestedAt,
      availableAt: request.currentFile?.availableAt ?? null,
      ...documentRequestCapabilities(
        request.supersededAt,
        request.currentFile,
        mutable,
      ),
    }));
  }
}
