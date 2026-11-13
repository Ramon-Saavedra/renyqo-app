import {
  ApplicationListingAccess,
  actorUserId as actorIdentity,
  type ApplicationActor,
} from '../listings/application-listing-access';
import type { ProviderActor } from '../provider-authorization/provider-listing-access';
import {
  verificationIdentity,
  loadVerificationIdentities,
  type VerificationIdentity,
} from './verification-projection';
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
    private readonly listingBoundary: ApplicationListingAccess,
    private readonly access: ApplicationDocumentAccessService,
    private readonly requirements: VerificationRequirementService,
  ) {}

  list(
    applicationId: string,
    actor: ApplicationActor,
    audience: DocumentAudience,
  ): Promise<DocumentRequestResponseDto[]> {
    const userId = actorIdentity(actor);
    return this.listingBoundary.read(
      actor,
      audience,
      applicationId,
      async (tx) => {
        await this.access.authorize(tx, applicationId, userId, audience);
      },
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
        const enriched = await loadVerificationIdentities(tx, requests);
        return enriched.map((request) =>
          this.toDto(
            request,
            mutable && audience === 'applicant',
            mutable && audience === 'provider',
          ),
        );
      },
    );
  }

  async create(
    applicationId: string,
    actor: ProviderActor,
    inputs: DocumentRequestInputDto[],
  ): Promise<DocumentRequestResponseDto[]> {
    const result = await this.requirements.execute(applicationId, actor, {
      operation: 'REQUEST',
      items: inputs,
    });
    return this.projectResult(
      applicationId,
      actor,
      result.requirements.map((r) => r.id),
    );
  }
  async cancel(
    applicationId: string,
    requestId: string,
    actor: ProviderActor,
  ): Promise<DocumentRequestResponseDto> {
    await this.requirements.execute(applicationId, actor, {
      operation: 'CANCEL',
      requestId,
    });
    return (await this.projectResult(applicationId, actor, [requestId]))[0];
  }
  async replace(
    applicationId: string,
    requestId: string,
    actor: ProviderActor,
  ): Promise<DocumentRequestResponseDto> {
    const result = await this.requirements.execute(applicationId, actor, {
      operation: 'REPLACE',
      requestId,
    });
    return (
      await this.projectResult(applicationId, actor, [
        result.requirements[1].id,
      ])
    )[0];
  }
  private projectResult(
    applicationId: string,
    actor: ProviderActor,
    ids: string[],
  ) {
    const userId = actor.authority.userId;
    return this.listingBoundary.read(
      actor,
      'provider',
      applicationId,
      async (tx) => {
        await this.access.authorize(tx, applicationId, userId, 'provider');
      },
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
        const enriched = await loadVerificationIdentities(tx, rows);
        return ids.map((id) => {
          const row = enriched.find((r) => r.id === id);
          if (!row) throw new NotFoundException('Document request not found');
          return this.toDto(row, false, mutable);
        });
      },
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
    request: ApplicationDocumentRequest &
      VerificationIdentity & { files: ApplicationDocumentFile[] },
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
      verificationIdentity(request),
    );
  }
}
