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
  ): Promise<ApplicationActivity> {
    return tx.applicationActivity.create({
      data: {
        applicationId,
        type,
        actorType:
          type === ApplicationActivityType.DOCUMENT_UPLOADED
            ? ApplicationActivityActorType.APPLICANT
            : ApplicationActivityActorType.PROVIDER,
        visibility: ApplicationActivityVisibility.BOTH,
        payload: { requestId, documentType },
      },
    });
  }
}
