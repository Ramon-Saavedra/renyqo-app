import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { documentRequestCapabilities } from './application-document.policy';

@Injectable()
export class ApplicationDocumentReadService {
  batch(tx: Prisma.TransactionClient, applicationIds: readonly string[]) {
    return tx.applicationDocumentRequest.findMany({
      where: { applicationId: { in: [...applicationIds] }, supersededAt: null },
      select: {
        id: true,
        applicationId: true,
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
