import { documentRequestCapabilities } from '../application-documents/application-document.policy';
import { ApplicationPendingActionService } from './application-pending-action.service';
import { ApplicationPendingActionType as Action } from './application-pending-action';
import {
  projectApplicationAttention,
  summarizeAttentionTotals,
  type AttentionDocumentSource,
} from './attention-projection';
import { AttentionSection } from './dto/attention-response.dto';
import {
  ApplicationDocumentState,
  ApplicationDocumentType,
  ApplicationStatus,
  ListingStatus,
} from '../generated/prisma/enums';

describe('attention projection', () => {
  const service = new ApplicationPendingActionService();
  const asOf = new Date('2027-01-01T10:00:00Z');
  const startsAt = new Date('2027-01-01T11:00:00Z');
  const endsAt = new Date('2027-01-01T12:00:00Z');
  const application = {
    id: 'application',
    status: ApplicationStatus.ACTIVE,
    listing: { status: ListingStatus.PUBLISHED },
  };
  const conversation = {
    hasMessages: true,
    applicantRepliesEnabled: false,
    historicalUnreadMessageCount: 2,
  };

  function project(
    audience: 'applicant' | 'provider',
    documents: AttentionDocumentSource[] = [],
    revalidatesAt: Date[] = [],
    unread = conversation.historicalUnreadMessageCount,
  ) {
    const derived = service.derive(
      application,
      audience,
      { ...conversation, historicalUnreadMessageCount: unread },
      documents.map((document) => {
        const capabilities = documentRequestCapabilities(
          document.supersededAt,
          document.currentFile,
          true,
        );
        return {
          requestId: document.id,
          documentId: document.currentFile?.id ?? null,
          requestedAt: asOf,
          availableAt: document.currentFile?.availableAt ?? null,
          canUpload: audience === 'applicant' && capabilities.canUpload,
          canReview: audience === 'provider' && capabilities.canReview,
        };
      }),
      [],
      asOf,
    );
    return projectApplicationAttention({
      applicationId: 'application',
      listingId: 'listing',
      pendingActions: derived.pendingActions,
      actionableUnreadMessageCount: derived.actionableUnreadMessageCount,
      historicalUnreadMessageCount: derived.historicalUnreadMessageCount,
      conversation: derived.conversation,
      asOf,
      documents,
      revalidatesAt,
    });
  }

  function document(
    overrides: Partial<AttentionDocumentSource> = {},
  ): AttentionDocumentSource {
    return {
      id: 'request',
      type: ApplicationDocumentType.SCHUFA,
      customLabel: null,
      supersededAt: null,
      currentFile: null,
      ...overrides,
    };
  }

  it('keeps unread separate from pending-action categories', () => {
    const result = project('applicant');
    expect(result.pendingActionCount).toBe(0);
    expect(result.actionableUnreadMessageCount).toBe(2);
    expect(result.categories).toEqual({
      documentUploadCount: 0,
      documentReviewCount: 0,
      viewingActionCount: 0,
    });
    expect(result.targets).toEqual([
      {
        applicationId: 'application',
        listingId: 'listing',
        section: AttentionSection.MESSAGES,
      },
    ]);
    expect(JSON.stringify(result.targets)).not.toMatch(/https?:|\/listings\//);
  });

  it('counts a viewing obligation separately from documents and unread', () => {
    const derived = service.derive(
      application,
      'applicant',
      { ...conversation, historicalUnreadMessageCount: 0 },
      [],
      [
        {
          viewingId: 'viewing',
          nextAction: 'APPLICANT_RESPOND_TO_VIEWING',
          pendingSince: asOf,
        },
      ],
      asOf,
    );
    const result = projectApplicationAttention({
      applicationId: 'application',
      listingId: 'listing',
      pendingActions: derived.pendingActions,
      actionableUnreadMessageCount: derived.actionableUnreadMessageCount,
      historicalUnreadMessageCount: derived.historicalUnreadMessageCount,
      conversation: derived.conversation,
      asOf,
      documents: [],
      revalidatesAt: [startsAt],
    });
    expect(result.categories).toEqual({
      documentUploadCount: 0,
      documentReviewCount: 0,
      viewingActionCount: 1,
    });
    expect(result.pendingActionCount).toBe(1);
    expect(result.targets).toEqual([
      {
        applicationId: 'application',
        listingId: 'listing',
        section: AttentionSection.VIEWING,
        viewingId: 'viewing',
      },
    ]);
    expect(result.nextRevalidateAt).toEqual(startsAt);
  });

  it('projects applicant upload obligations, including OTHER labels', () => {
    const other = document({
      id: 'other-request',
      type: ApplicationDocumentType.OTHER,
      customLabel: 'Pet agreement',
    });
    const income = document({
      id: 'income-request',
      type: ApplicationDocumentType.INCOME_PROOF,
    });
    const result = project('applicant', [other, income], [], 0);
    expect(result.categories).toEqual({
      documentUploadCount: 2,
      documentReviewCount: 0,
      viewingActionCount: 0,
    });
    expect(result.categories.documentUploadCount).toBe(
      result.pendingActionCount,
    );
    expect(result.documentIndicators).toEqual([
      {
        requestId: 'income-request',
        type: ApplicationDocumentType.INCOME_PROOF,
        customLabel: null,
        status: 'UPLOAD_REQUIRED',
      },
      {
        requestId: 'other-request',
        type: ApplicationDocumentType.OTHER,
        customLabel: 'Pet agreement',
        status: 'UPLOAD_REQUIRED',
      },
    ]);
    expect(result.targets.map((target) => target.section)).toEqual([
      AttentionSection.DOCUMENTS,
      AttentionSection.DOCUMENTS,
    ]);
    expect(result.targets[1]).toMatchObject({ requestId: 'other-request' });
    expect(JSON.parse(JSON.stringify(result.targets[0]))).not.toHaveProperty(
      'documentId',
    );
  });

  it('projects provider review obligations without an upload count', () => {
    const ready = document({
      type: ApplicationDocumentType.LIABILITY_INSURANCE,
      currentFile: {
        id: 'file',
        state: ApplicationDocumentState.AVAILABLE,
        availableAt: asOf,
        reviewedAt: null,
      },
    });
    const result = project('provider', [ready], [], 0);
    expect(result.pendingActions[0]?.type).toBe(Action.REVIEW_DOCUMENT);
    expect(result.categories).toEqual({
      documentUploadCount: 0,
      documentReviewCount: 1,
      viewingActionCount: 0,
    });
    expect(result.documentIndicators).toEqual([
      {
        requestId: 'request',
        documentId: 'file',
        type: ApplicationDocumentType.LIABILITY_INSURANCE,
        customLabel: null,
        status: 'RECEIVED',
      },
    ]);
    expect(result.targets[0]).toMatchObject({
      section: AttentionSection.DOCUMENTS,
      requestId: 'request',
      documentId: 'file',
    });
  });

  it('does not treat processing or reviewed files as document attention', () => {
    const processing = document({
      id: 'processing',
      currentFile: {
        id: 'processing-file',
        state: ApplicationDocumentState.PROCESSING,
        availableAt: null,
        reviewedAt: null,
      },
    });
    const reviewed = document({
      id: 'reviewed',
      currentFile: {
        id: 'reviewed-file',
        state: ApplicationDocumentState.AVAILABLE,
        availableAt: asOf,
        reviewedAt: asOf,
      },
    });
    const applicant = project('applicant', [processing, reviewed], [], 0);
    const provider = project('provider', [processing, reviewed], [], 0);
    expect(applicant.pendingActionCount).toBe(0);
    expect(applicant.documentIndicators).toEqual([]);
    expect(provider.pendingActionCount).toBe(0);
    expect(provider.documentIndicators).toEqual([]);
  });

  it('uses the earliest future viewing boundary and ignores past ones', () => {
    const result = project('applicant', [], [endsAt, startsAt, asOf]);
    expect(result.nextRevalidateAt).toEqual(startsAt);
    const none = project('applicant', [], [asOf]);
    expect(none.nextRevalidateAt).toBeNull();
  });

  it('sums categories across applications without adding unread to pending actions', () => {
    const first = project('applicant', [document()], [endsAt], 3);
    const second = project(
      'provider',
      [
        document({
          currentFile: {
            id: 'file',
            state: ApplicationDocumentState.AVAILABLE,
            availableAt: asOf,
            reviewedAt: null,
          },
        }),
      ],
      [startsAt],
      1,
    );
    const totals = summarizeAttentionTotals([first, second]);
    expect(totals.totalPendingActions).toBe(
      first.pendingActionCount + second.pendingActionCount,
    );
    expect(totals.actionableUnreadMessageCount).toBe(4);
    expect(totals.categories).toEqual({
      documentUploadCount: 1,
      documentReviewCount: 1,
      viewingActionCount: 0,
    });
    expect(
      totals.categories.documentUploadCount +
        totals.categories.documentReviewCount +
        totals.categories.viewingActionCount,
    ).toBe(totals.totalPendingActions);
    expect(totals.nextRevalidateAt).toEqual(startsAt);
  });

  it('drops actionable unread when the application is not mutable', () => {
    const derived = service.derive(
      {
        ...application,
        status: ApplicationStatus.REJECTED,
      },
      'applicant',
      conversation,
      [],
      [],
      asOf,
    );
    const result = projectApplicationAttention({
      applicationId: 'application',
      listingId: 'listing',
      pendingActions: derived.pendingActions,
      actionableUnreadMessageCount: derived.actionableUnreadMessageCount,
      historicalUnreadMessageCount: derived.historicalUnreadMessageCount,
      conversation: derived.conversation,
      asOf,
      documents: [],
      revalidatesAt: [],
    });
    expect(result.historicalUnreadMessageCount).toBe(2);
    expect(result.actionableUnreadMessageCount).toBe(0);
    expect(result.pendingActionCount).toBe(0);
    expect(result.targets).toEqual([]);
    expect(result.categories.viewingActionCount).toBe(0);
  });
});
