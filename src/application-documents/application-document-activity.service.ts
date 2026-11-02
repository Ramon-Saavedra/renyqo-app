import { Injectable } from '@nestjs/common';
import type { ApplicationActivity, Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationDocumentType,
} from '../generated/prisma/enums';

@Injectable()
export class ApplicationDocumentActivityService {
  append(
    tx: Prisma.TransactionClient,
    applicationId: string,
    requestId: string,
    documentType: ApplicationDocumentType,
    type: ApplicationActivityType,
    actorUserId?: string,
    scopeRevision?: number,
    predecessorId?: string,
  ): Promise<ApplicationActivity> {
    return tx.applicationActivity.create({
      data: {
        applicationId,
        actorUserId,
        type,
        actorType:
          type === ApplicationActivityType.DOCUMENT_UPLOADED
            ? ApplicationActivityActorType.APPLICANT
            : ApplicationActivityActorType.PROVIDER,
        visibility: ApplicationActivityVisibility.BOTH,
        payload: {
          requestId,
          documentType,
          ...(scopeRevision === undefined ? {} : { scopeRevision }),
          ...(predecessorId ? { predecessorId } : {}),
        },
      },
    });
  }
}
