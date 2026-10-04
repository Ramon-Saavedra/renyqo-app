import {
  ApplicationStatus,
  ListingStatus,
  ConversationSide,
  ApplicationDocumentState,
  ApplicationDocumentType,
  ApplicationViewingStatus,
  ViewingOutcome,
} from '../generated/prisma/enums';
import { ApplicationConversationReadService } from '../application-conversation/application-conversation-read.service';
import { ApplicationDocumentReadService } from '../application-documents/application-document-read.service';
import { ApplicationViewingReadService } from '../application-viewings/application-viewing-read.service';
import {
  ApplicationViewingPolicy,
  CORRECTION_WINDOW_MS,
} from '../application-viewings/application-viewing.policy';
import {
  applicationCanWithdraw,
  providerApplicationIsVisible,
  providerCurationAllowed,
} from '../applications/application-process.policy';
import { PROVIDER_CURATION_COOLDOWN_MS } from '../applications/application-lifecycle.constants';
import { toPublicActivityPayload } from '../applications/application-activity.policy';

const now = new Date('2027-01-01T10:00:00Z');
const active = {
  status: ApplicationStatus.ACTIVE,
  listing: { status: ListingStatus.PUBLISHED },
};
const documentRead = new ApplicationDocumentReadService();
const viewingRead = new ApplicationViewingReadService(
  new ApplicationViewingPolicy(),
);

describe('Read model domain projections', () => {
  it.each([ConversationSide.APPLICANT, ConversationSide.PROVIDER])(
    'keeps turn-taking authoritative for %s',
    (side) => {
      const service = new ApplicationConversationReadService();
      const summary = service.summary(active, ConversationSide.PROVIDER, side);
      expect(summary).toMatchObject({
        isOpen: true,
        isReadOnly: false,
        expectedResponder: ConversationSide.APPLICANT,
        canCurrentUserSend: side === ConversationSide.APPLICANT,
      });
    },
  );

  it('allows only the provider to initiate an unopened conversation', () => {
    const service = new ApplicationConversationReadService();
    expect(
      service.summary(active, null, ConversationSide.PROVIDER),
    ).toMatchObject({ isOpen: false, canCurrentUserSend: true });
    expect(
      service.summary(active, null, ConversationSide.APPLICANT)
        .canCurrentUserSend,
    ).toBe(false);
  });

  it.each([
    ApplicationStatus.WAITING,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])('makes %s conversation history read-only', (status) => {
    expect(
      new ApplicationConversationReadService().summary(
        { ...active, status },
        ConversationSide.PROVIDER,
        ConversationSide.APPLICANT,
      ),
    ).toMatchObject({
      isReadOnly: true,
      expectedResponder: null,
      canCurrentUserSend: false,
    });
  });

  function request(state?: ApplicationDocumentState, reviewed = false) {
    return {
      id: 'request',
      applicationId: 'application',
      type: ApplicationDocumentType.INCOME_PROOF,
      customLabel: null,
      requestedAt: now,
      supersededAt: null,
      currentFile: state
        ? {
            id: 'file',
            state,
            availableAt:
              state === ApplicationDocumentState.AVAILABLE ? now : null,
            reviewedAt: reviewed ? now : null,
          }
        : null,
    };
  }

  it('derives audience-specific document operations and no storage fields', () => {
    const records = [
      request(),
      request(ApplicationDocumentState.PROCESSING),
      request(ApplicationDocumentState.AVAILABLE),
    ];
    const applicant = documentRead.summary(records, true, 'applicant');
    const provider = documentRead.summary(records, true, 'provider');
    expect(applicant.counts).toMatchObject({
      requestedCount: 3,
      uploadRequiredCount: 1,
      reviewRequiredCount: 0,
      processingCount: 1,
    });
    expect(provider.counts).toMatchObject({
      uploadRequiredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(Object.keys(applicant.currentRequests[0]).sort()).toEqual([
      'canDownload',
      'canRequestReplacement',
      'canReview',
      'canUpload',
      'customLabel',
      'documentId',
      'requestId',
      'status',
      'type',
    ]);
  });

  it('removes reviewed document obligations and terminal operations', () => {
    expect(
      documentRead.summary(
        [request(ApplicationDocumentState.AVAILABLE, true)],
        true,
        'provider',
      ).counts.reviewRequiredCount,
    ).toBe(0);
    expect(
      documentRead.summary([request()], false, 'applicant').counts
        .uploadRequiredCount,
    ).toBe(0);
  });

  function viewing(
    status: ApplicationViewingStatus = ApplicationViewingStatus.PROPOSED,
  ) {
    return {
      id: 'viewing',
      applicationId: 'application',
      round: 1,
      status,
      startsAt: new Date(now.getTime() + 60000),
      endsAt: new Date(now.getTime() + 1860000),
      timeZone: 'Europe/Berlin',
      createdAt: now,
      changeRequestedAt: null,
      interest: null,
      outcomes: [] as {
        recordedAt: Date;
        revision: number;
        outcome: ViewingOutcome;
      }[],
    };
  }

  it('derives future proposal capabilities from the viewing policy', () => {
    const result = viewingRead.summary([viewing()], true, 1, now, 'applicant');
    expect(result.nextAction).toBe('APPLICANT_RESPOND_TO_VIEWING');
    expect(result.current?.capabilities).toMatchObject({
      canAccept: true,
      canDecline: true,
      canRequestAnotherTime: true,
      canMarkCompleted: false,
    });
  });

  it('derives expired proposal closure and completed viewing outcome actions', () => {
    const after = new Date(now.getTime() + 3600000);
    expect(
      viewingRead.summary([viewing()], true, 1, after, 'provider').nextAction,
    ).toBe('PROVIDER_CLOSE_UNANSWERED_VIEWING');
    expect(
      viewingRead.summary(
        [viewing(ApplicationViewingStatus.ACCEPTED)],
        true,
        1,
        after,
        'provider',
      ).current?.capabilities.canMarkCompleted,
    ).toBe(true);
  });

  it('keeps original and corrected effective outcomes distinct for capabilities', () => {
    const row = viewing(ApplicationViewingStatus.COMPLETED);
    row.outcomes = [
      { recordedAt: now, revision: 1, outcome: ViewingOutcome.COMPLETED },
    ];
    expect(
      viewingRead.summary([row], true, 1, now, 'provider').latest?.capabilities
        .canCorrectOutcome,
    ).toBe(true);
    expect(
      viewingRead.summary(
        [row],
        true,
        1,
        new Date(now.getTime() + CORRECTION_WINDOW_MS),
        'provider',
      ).latest?.capabilities.canCorrectOutcome,
    ).toBe(false);
    row.outcomes.push({
      recordedAt: now,
      revision: 2,
      outcome: ViewingOutcome.NO_SHOW,
    });
    row.status = ApplicationViewingStatus.NO_SHOW;
    const summary = viewingRead.summary([row], true, 1, now, 'provider');
    expect(summary.latest?.effectiveOutcome).toBe(ViewingOutcome.NO_SHOW);
    expect(summary.latest?.capabilities.canCorrectOutcome).toBe(false);
    expect(summary.pendingInterest).toBeNull();
  });

  it('disables viewing operations in terminal application state', () => {
    const summary = viewingRead.summary(
      [viewing()],
      false,
      1,
      now,
      'applicant',
    );
    expect(summary.nextAction).toBe('NONE');
    expect(summary.latest?.capabilities.canAccept).toBe(false);
  });

  it('uses authoritative withdrawal and provider cooldown boundaries', () => {
    expect(applicationCanWithdraw(ApplicationStatus.WAITING)).toBe(true);
    expect(applicationCanWithdraw(ApplicationStatus.REJECTED)).toBe(false);
    expect(providerCurationAllowed(now, now)).toBe(false);
    expect(
      providerCurationAllowed(
        now,
        new Date(now.getTime() + PROVIDER_CURATION_COOLDOWN_MS),
      ),
    ).toBe(true);
  });

  it.each([
    ApplicationStatus.WAITING,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
  ])('hides never-active %s identities', (status) => {
    expect(providerApplicationIsVisible({ status, activeAt: null })).toBe(
      false,
    );
  });

  it('allows previously-active terminal history but keeps WAITING hidden', () => {
    expect(
      providerApplicationIsVisible({
        status: ApplicationStatus.REJECTED,
        activeAt: now,
      }),
    ).toBe(true);
    expect(
      providerApplicationIsVisible({
        status: ApplicationStatus.WAITING,
        activeAt: now,
      }),
    ).toBe(false);
  });

  it('uses a shared allowlist for activity payloads', () => {
    expect(
      toPublicActivityPayload({
        initialStatus: ApplicationStatus.ACTIVE,
        reason: 'private',
        actorUserId: 'private',
        storageKey: 'private',
      }),
    ).toEqual({ initialStatus: ApplicationStatus.ACTIVE });
  });

  it.each(['initialStatus', 'fromStatus', 'toStatus'] as const)(
    'excludes invalid %s values from public activity payloads',
    (key) => {
      for (const value of ['INVALID_STATUS', '', 1, null, {}]) {
        expect(toPublicActivityPayload({ [key]: value })).toEqual({});
      }
      for (const value of Object.values(ApplicationStatus)) {
        expect(toPublicActivityPayload({ [key]: value })).toEqual({
          [key]: value,
        });
      }
    },
  );
});
