import { CompactConversationSummaryDto } from '../../application-conversation/dto/compact-conversation-summary.dto';
import type { ApplicationDocumentType } from '../../generated/prisma/enums';
import { ApplicationPendingActionType as Action } from '../application-pending-action';
import type { ViewingWorkflowProjection } from '../../application-viewings/viewing-workflow-projection';

export enum AttentionSection {
  MESSAGES = 'MESSAGES',
  DOCUMENTS = 'DOCUMENTS',
  VIEWING = 'VIEWING',
}

export type DocumentAttentionStatus = 'UPLOAD_REQUIRED' | 'RECEIVED';

export class DocumentUploadTargetDto {
  constructor(readonly requestId: string) {}
}

export class DocumentReviewTargetDto {
  constructor(
    readonly requestId: string,
    readonly documentId: string,
  ) {}
}

export class ViewingTargetDto {
  constructor(
    readonly viewingId: string,
    readonly workflowTarget?: ViewingWorkflowProjection['obligations'][number]['target'],
  ) {}
}

export class DocumentUploadPendingActionDto {
  readonly type = Action.UPLOAD_REQUESTED_DOCUMENT;
  readonly source = 'DOCUMENT';
  constructor(readonly target: DocumentUploadTargetDto) {}
}

export class DocumentReviewPendingActionDto {
  readonly type = Action.REVIEW_DOCUMENT;
  readonly source = 'DOCUMENT';
  constructor(readonly target: DocumentReviewTargetDto) {}
}

export type ViewingPendingActionType = Exclude<
  Action,
  Action.UPLOAD_REQUESTED_DOCUMENT | Action.REVIEW_DOCUMENT
>;

export class ViewingPendingActionDto {
  readonly source = 'VIEWING';
  constructor(
    readonly type: ViewingPendingActionType,
    readonly target: ViewingTargetDto,
  ) {}
}

export type PendingActionDto =
  | DocumentUploadPendingActionDto
  | DocumentReviewPendingActionDto
  | ViewingPendingActionDto;

export class AttentionCategoryTotalsDto {
  constructor(
    readonly documentUploadCount: number,
    readonly documentReviewCount: number,
    readonly viewingActionCount: number,
  ) {}
}

export class AttentionTargetDto {
  readonly workflowTarget?: ViewingWorkflowProjection['obligations'][number]['target'];
  readonly requestId?: string;
  readonly documentId?: string;
  readonly viewingId?: string;
  constructor(
    readonly applicationId: string,
    readonly listingId: string,
    readonly section: AttentionSection,
    ids?: {
      requestId?: string;
      documentId?: string;
      viewingId?: string;
      workflowTarget?: ViewingWorkflowProjection['obligations'][number]['target'];
    },
  ) {
    if (ids?.requestId !== undefined) this.requestId = ids.requestId;
    if (ids?.documentId !== undefined) this.documentId = ids.documentId;
    if (ids?.viewingId !== undefined) this.viewingId = ids.viewingId;
    if (ids?.workflowTarget !== undefined)
      this.workflowTarget = ids.workflowTarget;
  }
}

export class DocumentAttentionIndicatorDto {
  readonly documentId?: string;
  constructor(
    readonly requestId: string,
    readonly type: ApplicationDocumentType,
    readonly customLabel: string | null,
    readonly status: DocumentAttentionStatus,
    documentId?: string,
  ) {
    if (documentId !== undefined) this.documentId = documentId;
  }
}

export class ApplicationAttentionSummaryDto {
  viewing?: ViewingWorkflowProjection;
  readonly hasPendingAction: boolean;
  constructor(
    readonly pendingActionCount: number,
    readonly actionableUnreadMessageCount: number,
    readonly categories: AttentionCategoryTotalsDto,
    readonly targets: readonly AttentionTargetDto[],
    readonly documentIndicators: readonly DocumentAttentionIndicatorDto[],
    readonly nextRevalidateAt: Date | null,
  ) {
    this.hasPendingAction = pendingActionCount > 0;
  }
}

export class ApplicationAttentionResponseDto extends ApplicationAttentionSummaryDto {
  constructor(
    readonly applicationId: string,
    readonly pendingActions: PendingActionDto[],
    readonly historicalUnreadMessageCount: number,
    actionableUnreadMessageCount: number,
    readonly conversation: CompactConversationSummaryDto,
    readonly asOf: Date,
    categories: AttentionCategoryTotalsDto,
    targets: readonly AttentionTargetDto[],
    documentIndicators: readonly DocumentAttentionIndicatorDto[],
    nextRevalidateAt: Date | null,
  ) {
    super(
      pendingActions.length,
      actionableUnreadMessageCount,
      categories,
      targets,
      documentIndicators,
      nextRevalidateAt,
    );
  }
}

export class ApplicationAttentionListItemDto extends ApplicationAttentionSummaryDto {
  constructor(
    readonly applicationId: string,
    readonly listingId: string,
    readonly listingTitle: string | null,
    readonly listingCity: string | null,
    summary: ApplicationAttentionSummaryDto,
  ) {
    super(
      summary.pendingActionCount,
      summary.actionableUnreadMessageCount,
      summary.categories,
      summary.targets,
      summary.documentIndicators,
      summary.nextRevalidateAt,
    );
    this.viewing = summary.viewing;
  }
}

export class ApplicantListingAttentionDto extends ApplicationAttentionSummaryDto {
  constructor(
    readonly applicationId: string,
    summary: ApplicationAttentionSummaryDto,
  ) {
    super(
      summary.pendingActionCount,
      summary.actionableUnreadMessageCount,
      summary.categories,
      summary.targets,
      summary.documentIndicators,
      summary.nextRevalidateAt,
    );
    this.viewing = summary.viewing;
  }
}

export class AttentionTotalsDto {
  constructor(
    readonly applicationsWithPendingActions: number,
    readonly totalPendingActions: number,
    readonly actionableUnreadMessageCount: number,
    readonly categories: AttentionCategoryTotalsDto,
    readonly nextRevalidateAt: Date | null,
  ) {}
}

export class ListingAttentionTotalsDto extends AttentionTotalsDto {
  constructor(
    readonly listingId: string,
    totals: AttentionTotalsDto,
  ) {
    super(
      totals.applicationsWithPendingActions,
      totals.totalPendingActions,
      totals.actionableUnreadMessageCount,
      totals.categories,
      totals.nextRevalidateAt,
    );
  }
}

export class AttentionPaginationDto {
  readonly hasMore: boolean;
  constructor(
    readonly offset: number,
    readonly limit: number,
    readonly totalApplications: number,
  ) {
    this.hasMore = offset + limit < totalApplications;
  }
}

export class AttentionAggregateResponseDto {
  constructor(
    readonly asOf: Date,
    readonly totals: AttentionTotalsDto,
    readonly listings: ListingAttentionTotalsDto[],
    readonly items: ApplicationAttentionListItemDto[],
    readonly pagination: AttentionPaginationDto,
  ) {}
}

export class AttentionBatchResponseDto {
  constructor(
    readonly asOf: Date,
    readonly items: ApplicationAttentionListItemDto[],
  ) {}
}
