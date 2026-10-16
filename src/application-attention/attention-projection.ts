import { documentRequestStatus } from '../application-documents/application-document.policy';
import type { ApplicationDocumentState } from '../generated/prisma/enums';
import type { ApplicationDocumentType } from '../generated/prisma/enums';
import { ApplicationPendingActionType as Action } from './application-pending-action';
import {
  ApplicationAttentionResponseDto,
  ApplicationAttentionSummaryDto,
  AttentionCategoryTotalsDto,
  AttentionSection,
  AttentionTargetDto,
  AttentionTotalsDto,
  DocumentAttentionIndicatorDto,
  type DocumentAttentionStatus,
  type PendingActionDto,
} from './dto/attention-response.dto';
import type { CompactConversationSummaryDto } from '../application-conversation/dto/compact-conversation-summary.dto';

export type AttentionDocumentSource = {
  id: string;
  type: ApplicationDocumentType;
  customLabel: string | null;
  supersededAt: Date | null;
  currentFile: {
    id: string;
    state: ApplicationDocumentState;
    availableAt: Date | null;
    reviewedAt: Date | null;
  } | null;
};

export type ProjectApplicationAttentionInput = {
  applicationId: string;
  listingId: string;
  pendingActions: readonly PendingActionDto[];
  actionableUnreadMessageCount: number;
  historicalUnreadMessageCount: number;
  conversation: CompactConversationSummaryDto;
  asOf: Date;
  documents: readonly AttentionDocumentSource[];
  revalidatesAt: readonly Date[];
};

export function projectApplicationAttention(
  input: ProjectApplicationAttentionInput,
): ApplicationAttentionResponseDto {
  return new ApplicationAttentionResponseDto(
    input.applicationId,
    [...input.pendingActions],
    input.historicalUnreadMessageCount,
    input.actionableUnreadMessageCount,
    input.conversation,
    input.asOf,
    categoriesFor(input.pendingActions),
    targetsFor(input),
    documentIndicatorsFor(input.pendingActions, input.documents),
    earliestRevalidation(input.revalidatesAt, input.asOf),
  );
}

export function compactAttentionSummary(
  detail: ApplicationAttentionSummaryDto,
): ApplicationAttentionSummaryDto {
  return new ApplicationAttentionSummaryDto(
    detail.pendingActionCount,
    detail.actionableUnreadMessageCount,
    detail.categories,
    detail.targets,
    detail.documentIndicators,
    detail.nextRevalidateAt,
  );
}

export class AttentionTotalAccumulator {
  private applicationsWithPendingActions = 0;
  private totalPendingActions = 0;
  private actionableUnreadMessageCount = 0;
  private documentUploadCount = 0;
  private documentReviewCount = 0;
  private viewingActionCount = 0;
  private nextRevalidateAt: Date | null = null;

  add(summary: ApplicationAttentionSummaryDto): void {
    this.applicationsWithPendingActions += summary.hasPendingAction ? 1 : 0;
    this.totalPendingActions += summary.pendingActionCount;
    this.actionableUnreadMessageCount += summary.actionableUnreadMessageCount;
    this.documentUploadCount += summary.categories.documentUploadCount;
    this.documentReviewCount += summary.categories.documentReviewCount;
    this.viewingActionCount += summary.categories.viewingActionCount;
    this.nextRevalidateAt = earlierRevalidation(
      this.nextRevalidateAt,
      summary.nextRevalidateAt,
    );
  }

  toDto(): AttentionTotalsDto {
    return new AttentionTotalsDto(
      this.applicationsWithPendingActions,
      this.totalPendingActions,
      this.actionableUnreadMessageCount,
      new AttentionCategoryTotalsDto(
        this.documentUploadCount,
        this.documentReviewCount,
        this.viewingActionCount,
      ),
      this.nextRevalidateAt,
    );
  }
}

export function summarizeAttentionTotals(
  items: readonly ApplicationAttentionSummaryDto[],
): AttentionTotalsDto {
  const totals = new AttentionTotalAccumulator();
  for (const item of items) totals.add(item);
  return totals.toDto();
}

function categoriesFor(
  actions: readonly PendingActionDto[],
): AttentionCategoryTotalsDto {
  let documentUploadCount = 0;
  let documentReviewCount = 0;
  let viewingActionCount = 0;
  for (const action of actions) {
    if (action.type === Action.UPLOAD_REQUESTED_DOCUMENT)
      documentUploadCount += 1;
    else if (action.type === Action.REVIEW_DOCUMENT) documentReviewCount += 1;
    else viewingActionCount += 1;
  }
  return new AttentionCategoryTotalsDto(
    documentUploadCount,
    documentReviewCount,
    viewingActionCount,
  );
}

function targetsFor(
  input: ProjectApplicationAttentionInput,
): AttentionTargetDto[] {
  const targets: AttentionTargetDto[] = [];
  if (input.actionableUnreadMessageCount > 0) {
    targets.push(
      new AttentionTargetDto(
        input.applicationId,
        input.listingId,
        AttentionSection.MESSAGES,
      ),
    );
  }
  for (const action of input.pendingActions) {
    if (action.type === Action.UPLOAD_REQUESTED_DOCUMENT) {
      targets.push(
        new AttentionTargetDto(
          input.applicationId,
          input.listingId,
          AttentionSection.DOCUMENTS,
          { requestId: action.target.requestId },
        ),
      );
    } else if (action.type === Action.REVIEW_DOCUMENT) {
      targets.push(
        new AttentionTargetDto(
          input.applicationId,
          input.listingId,
          AttentionSection.DOCUMENTS,
          {
            requestId: action.target.requestId,
            documentId: action.target.documentId,
          },
        ),
      );
    } else {
      targets.push(
        new AttentionTargetDto(
          input.applicationId,
          input.listingId,
          AttentionSection.VIEWING,
          { viewingId: action.target.viewingId },
        ),
      );
    }
  }
  return targets;
}

function documentIndicatorsFor(
  actions: readonly PendingActionDto[],
  documents: readonly AttentionDocumentSource[],
): DocumentAttentionIndicatorDto[] {
  const documentsByRequest = new Map(
    documents.map((document) => [document.id, document]),
  );
  const indicators: DocumentAttentionIndicatorDto[] = [];
  for (const action of actions) {
    if (
      action.type !== Action.UPLOAD_REQUESTED_DOCUMENT &&
      action.type !== Action.REVIEW_DOCUMENT
    ) {
      continue;
    }
    const document = documentsByRequest.get(action.target.requestId);
    if (!document) continue;
    const status = documentRequestStatus(
      document.supersededAt,
      document.currentFile,
    );
    if (!isObligationStatus(status)) continue;
    if (
      action.type === Action.UPLOAD_REQUESTED_DOCUMENT &&
      status !== 'UPLOAD_REQUIRED'
    ) {
      continue;
    }
    if (action.type === Action.REVIEW_DOCUMENT && status !== 'RECEIVED')
      continue;
    indicators.push(
      new DocumentAttentionIndicatorDto(
        document.id,
        document.type,
        document.customLabel,
        status,
        action.type === Action.REVIEW_DOCUMENT
          ? action.target.documentId
          : undefined,
      ),
    );
  }
  return indicators;
}

function isObligationStatus(
  status: ReturnType<typeof documentRequestStatus>,
): status is DocumentAttentionStatus {
  return status === 'UPLOAD_REQUIRED' || status === 'RECEIVED';
}

function earliestRevalidation(
  boundaries: readonly Date[],
  asOf: Date,
): Date | null {
  let earliest: Date | null = null;
  for (const boundary of boundaries) {
    if (boundary.getTime() <= asOf.getTime()) continue;
    earliest = earlierRevalidation(earliest, boundary);
  }
  return earliest;
}

function earlierRevalidation(
  current: Date | null,
  candidate: Date | null,
): Date | null {
  if (!candidate) return current;
  if (!current || candidate.getTime() < current.getTime()) return candidate;
  return current;
}
