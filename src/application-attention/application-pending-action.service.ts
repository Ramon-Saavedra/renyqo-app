import { CompactConversationSummaryDto } from '../application-conversation/dto/compact-conversation-summary.dto';
import { applicationProcessAllowsMutation } from '../applications/application-process.policy';
import { Injectable } from '@nestjs/common';
import { ConversationSide } from '../generated/prisma/enums';
import { conversationCapabilities } from '../application-conversation/application-conversation.policy';
import type { ConversationAttentionFacts } from '../application-conversation/application-conversation-read.service';
import type { ApplicationProcessState } from '../applications/application-process.policy';
import type { ViewingNextAction } from '../application-viewings/application-viewing.policy';
import {
  ApplicationPendingActionType as Action,
  type AttentionAudience,
} from './application-pending-action';
import {
  DocumentUploadPendingActionDto,
  DocumentUploadTargetDto,
  DocumentReviewPendingActionDto,
  DocumentReviewTargetDto,
  ViewingPendingActionDto,
  ViewingTargetDto,
  type PendingActionDto,
  type ViewingPendingActionType,
} from './dto/attention-response.dto';

export type DerivedApplicationAttention = {
  pendingActions: PendingActionDto[];
  pendingActionCount: number;
  hasPendingAction: boolean;
  historicalUnreadMessageCount: number;
  actionableUnreadMessageCount: number;
  conversation: CompactConversationSummaryDto;
  asOf: Date;
};

export type DocumentAttentionFact = {
  requestId: string;
  documentId: string | null;
  canUpload: boolean;
  canReview: boolean;
  requestedAt: Date;
  availableAt: Date | null;
};

export type ViewingAttentionFact = {
  workflowTarget?: import('../application-viewings/viewing-workflow-projection').ViewingWorkflowProjection['obligations'][number]['target'];
  viewingId: string;
  nextAction: ViewingNextAction;
  pendingSince: Date;
};

type Candidate = { dto: PendingActionDto; pendingSince: Date; target: string };

const viewingActions: Partial<
  Record<
    ViewingNextAction,
    { audience: AttentionAudience; type: ViewingPendingActionType }
  >
> = {
  PROVIDER_DECIDE_CONSIDERATION: {
    audience: 'provider',
    type: Action.DECIDE_VIEWING_CONSIDERATION,
  },
  APPLICANT_RESPOND_TO_VIEWING: {
    audience: 'applicant',
    type: Action.RESPOND_TO_VIEWING,
  },
  PROVIDER_RESPOND_TO_CHANGE_REQUEST: {
    audience: 'provider',
    type: Action.RESPOND_TO_VIEWING_CHANGE_REQUEST,
  },
  PROVIDER_CLOSE_UNANSWERED_VIEWING: {
    audience: 'provider',
    type: Action.CLOSE_UNANSWERED_VIEWING,
  },
  PROVIDER_RECORD_VIEWING_OUTCOME: {
    audience: 'provider',
    type: Action.RECORD_VIEWING_OUTCOME,
  },
  APPLICANT_CONFIRM_POST_VIEWING_INTEREST: {
    audience: 'applicant',
    type: Action.CONFIRM_POST_VIEWING_INTEREST,
  },
};

@Injectable()
export class ApplicationPendingActionService {
  derive(
    application: ApplicationProcessState & { id: string },
    audience: AttentionAudience,
    conversation: ConversationAttentionFacts,
    documents: readonly DocumentAttentionFact[],
    viewings: readonly ViewingAttentionFact[],
    asOf: Date,
  ): DerivedApplicationAttention {
    const side =
      audience === 'provider'
        ? ConversationSide.PROVIDER
        : ConversationSide.APPLICANT;
    const capabilities = conversationCapabilities(
      application,
      conversation.applicantRepliesEnabled,
      side,
    );
    const candidates: Candidate[] = [];
    for (const document of documents) {
      if (audience === 'applicant' && document.canUpload) {
        candidates.push({
          dto: new DocumentUploadPendingActionDto(
            new DocumentUploadTargetDto(document.requestId),
          ),
          pendingSince: document.requestedAt,
          target: document.requestId,
        });
      }
      if (
        audience === 'provider' &&
        document.canReview &&
        document.documentId &&
        document.availableAt
      ) {
        candidates.push({
          dto: new DocumentReviewPendingActionDto(
            new DocumentReviewTargetDto(
              document.requestId,
              document.documentId,
            ),
          ),
          pendingSince: document.availableAt,
          target: document.documentId,
        });
      }
    }
    for (const viewing of viewings) {
      const action = viewingActions[viewing.nextAction];
      if (action?.audience === audience) {
        candidates.push({
          dto: new ViewingPendingActionDto(
            action.type,
            new ViewingTargetDto(viewing.viewingId, viewing.workflowTarget),
          ),
          pendingSince: viewing.pendingSince,
          target: viewing.viewingId,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        a.pendingSince.getTime() - b.pendingSince.getTime() ||
        this.compare(a.dto.type, b.dto.type) ||
        this.compare(a.target, b.target),
    );
    const unique = new Map<string, PendingActionDto>();
    for (const candidate of candidates) {
      const key = `${audience}:${application.id}:${candidate.dto.type}:${candidate.target}`;
      if (!unique.has(key)) unique.set(key, candidate.dto);
    }
    const pendingActions = [...unique.values()];
    return {
      pendingActions,
      pendingActionCount: pendingActions.length,
      hasPendingAction: pendingActions.length > 0,
      historicalUnreadMessageCount: conversation.historicalUnreadMessageCount,
      actionableUnreadMessageCount: applicationProcessAllowsMutation(
        application,
      )
        ? conversation.historicalUnreadMessageCount
        : 0,
      conversation: new CompactConversationSummaryDto(
        conversation.hasMessages,
        capabilities,
      ),
      asOf,
    };
  }

  private compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}
