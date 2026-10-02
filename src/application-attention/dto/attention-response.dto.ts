import type { ConversationSide } from '../../generated/prisma/enums';
import { ApplicationPendingActionType as Action } from '../application-pending-action';

export class ConversationPendingActionDto {
  readonly type = Action.RESPOND_TO_MESSAGE;
  readonly source = 'CONVERSATION';
}

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
  constructor(readonly viewingId: string) {}
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
  | Action.RESPOND_TO_MESSAGE
  | Action.UPLOAD_REQUESTED_DOCUMENT
  | Action.REVIEW_DOCUMENT
>;

export class ViewingPendingActionDto {
  readonly source = 'VIEWING';
  constructor(
    readonly type: ViewingPendingActionType,
    readonly target: ViewingTargetDto,
  ) {}
}

export type PendingActionDto =
  | ConversationPendingActionDto
  | DocumentUploadPendingActionDto
  | DocumentReviewPendingActionDto
  | ViewingPendingActionDto;

export class AttentionConversationDto {
  constructor(
    readonly isOpen: boolean,
    readonly isReadOnly: boolean,
    readonly expectedResponder: ConversationSide | null,
  ) {}
}

export class ApplicationAttentionSummaryDto {
  readonly hasPendingAction: boolean;
  constructor(
    readonly pendingActionCount: number,
    readonly actionableUnreadMessageCount: number,
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
    readonly conversation: AttentionConversationDto,
    readonly asOf: Date,
  ) {
    super(pendingActions.length, actionableUnreadMessageCount);
  }
}

export class ApplicationAttentionListItemDto extends ApplicationAttentionSummaryDto {
  constructor(
    readonly applicationId: string,
    readonly listingId: string,
    summary: ApplicationAttentionSummaryDto,
  ) {
    super(summary.pendingActionCount, summary.actionableUnreadMessageCount);
  }
}

export class AttentionTotalsDto {
  constructor(
    readonly applicationsWithPendingActions: number,
    readonly totalPendingActions: number,
    readonly actionableUnreadMessageCount: number,
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
