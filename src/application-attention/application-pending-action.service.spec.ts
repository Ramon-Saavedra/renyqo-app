import {
  ApplicationPendingActionService,
  type DocumentAttentionFact,
  type ViewingAttentionFact,
} from './application-pending-action.service';
import { ApplicationPendingActionType as Action } from './application-pending-action';
import {
  ApplicationStatus,
  ConversationSide,
  ListingStatus,
  ApplicationDocumentState,
} from '../generated/prisma/enums';
import { conversationResponsibility } from '../application-conversation/application-conversation.policy';
import { documentRequestCapabilities } from '../application-documents/application-document.policy';
import {
  applicationProcessAllowsMutation,
  providerApplicationIsVisible,
  providerApplicationVisibility,
} from '../applications/application-process.policy';
import { AttentionQueryDto } from './dto/attention-input.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('Application attention derivation', () => {
  it('uses the same provider visibility definition for batched SQL scope', () => {
    expect(providerApplicationVisibility('provider')).toEqual({
      listing: { providerId: 'provider' },
      status: { notIn: [ApplicationStatus.WAITING] },
      OR: [
        { status: { in: [ApplicationStatus.ACTIVE] } },
        { activeAt: { not: null } },
      ],
    });
  });

  for (const status of Object.values(ApplicationStatus)) {
    for (const activeAt of [null, new Date('2027-01-01T00:00:00Z')]) {
      it(`preserves provider visibility for ${status} with history ${activeAt !== null}`, () => {
        expect(providerApplicationIsVisible({ status, activeAt })).toBe(
          status !== ApplicationStatus.WAITING &&
            (status === ApplicationStatus.ACTIVE || activeAt !== null),
        );
      });
    }
  }
  const service = new ApplicationPendingActionService();
  const asOf = new Date('2027-01-01T10:00:00Z');
  const application = {
    id: 'application',
    status: ApplicationStatus.ACTIVE,
    listing: { status: ListingStatus.PUBLISHED },
  };
  const conversation = {
    lastSender: ConversationSide.PROVIDER,
    lastMessageAt: asOf,
    historicalUnreadMessageCount: 2,
  };
  const document: DocumentAttentionFact = {
    requestId: 'request',
    documentId: null,
    canUpload: true,
    canReview: false,
    requestedAt: asOf,
    availableAt: null,
  };
  const viewing: ViewingAttentionFact = {
    viewingId: 'viewing',
    nextAction: 'APPLICANT_RESPOND_TO_VIEWING',
    pendingSince: asOf,
  };

  it('keeps unread and reply responsibility separate after reading', () => {
    const result = service.derive(
      application,
      'applicant',
      { ...conversation, historicalUnreadMessageCount: 0 },
      [],
      [],
      asOf,
    );
    expect(result.pendingActions.map((row) => row.type)).toEqual([
      Action.RESPOND_TO_MESSAGE,
    ]);
    expect(result.actionableUnreadMessageCount).toBe(0);
  });

  it('retains unread without inventing a reply when latest sender is this audience', () => {
    const result = service.derive(
      application,
      'applicant',
      { ...conversation, lastSender: ConversationSide.APPLICANT },
      [],
      [],
      asOf,
    );
    expect(result.pendingActions).toEqual([]);
    expect(result.actionableUnreadMessageCount).toBe(2);
  });

  it('creates no reply action for an unopened conversation', () => {
    expect(
      service.derive(
        application,
        'provider',
        {
          ...conversation,
          lastSender: null,
          lastMessageAt: null,
          historicalUnreadMessageCount: 0,
        },
        [],
        [],
        asOf,
      ).pendingActions,
    ).toEqual([]);
  });

  it('combines simultaneous actions and eliminates identical obligations', () => {
    const result = service.derive(
      application,
      'applicant',
      conversation,
      [document, document],
      [viewing, viewing],
      asOf,
    );
    expect(result.pendingActionCount).toBe(3);
    expect(result.hasPendingAction).toBe(true);
    expect(result.pendingActions.map((row) => row.type)).toEqual([
      Action.RESPOND_TO_MESSAGE,
      Action.RESPOND_TO_VIEWING,
      Action.UPLOAD_REQUESTED_DOCUMENT,
    ]);
    expect(JSON.stringify(result)).not.toContain('pendingSince');
    expect(result.asOf).toBe(asOf);
  });

  it('orders oldest first and breaks ties by type then target without input-order dependence', () => {
    const earlier = { ...viewing, pendingSince: new Date(asOf.getTime() - 1) };
    const documents = [document, { ...document, requestId: 'aaa' }];
    const first = service.derive(
      application,
      'applicant',
      conversation,
      documents,
      [earlier],
      asOf,
    );
    const second = service.derive(
      application,
      'applicant',
      conversation,
      [...documents].reverse(),
      [earlier],
      asOf,
    );
    expect(first).toEqual(second);
    expect(first.pendingActions[0]?.type).toBe(Action.RESPOND_TO_VIEWING);
    expect(first.pendingActions.at(-2)).toMatchObject({
      target: { requestId: 'aaa' },
    });
  });

  it.each([
    [
      'PROVIDER_RESPOND_TO_CHANGE_REQUEST',
      'provider',
      Action.RESPOND_TO_VIEWING_CHANGE_REQUEST,
    ],
    [
      'PROVIDER_CLOSE_UNANSWERED_VIEWING',
      'provider',
      Action.CLOSE_UNANSWERED_VIEWING,
    ],
    [
      'PROVIDER_RECORD_VIEWING_OUTCOME',
      'provider',
      Action.RECORD_VIEWING_OUTCOME,
    ],
    [
      'APPLICANT_CONFIRM_POST_VIEWING_INTEREST',
      'applicant',
      Action.CONFIRM_POST_VIEWING_INTEREST,
    ],
    ['APPLICANT_RESPOND_TO_VIEWING', 'applicant', Action.RESPOND_TO_VIEWING],
  ] as const)(
    'maps %s only to its responsible audience',
    (nextAction, audience, action) => {
      const facts = [{ ...viewing, nextAction }];
      const empty = {
        ...conversation,
        lastSender: null,
        lastMessageAt: null,
        historicalUnreadMessageCount: 0,
      };
      expect(
        service.derive(application, audience, empty, [], facts, asOf)
          .pendingActions,
      ).toMatchObject([{ type: action }]);
      expect(
        service.derive(
          application,
          audience === 'provider' ? 'applicant' : 'provider',
          empty,
          [],
          facts,
          asOf,
        ).pendingActions,
      ).toEqual([]);
    },
  );

  it('maps current document review only to provider', () => {
    const fact = {
      ...document,
      canUpload: false,
      canReview: true,
      documentId: 'file',
      availableAt: asOf,
    };
    expect(
      service.derive(application, 'provider', conversation, [fact], [], asOf)
        .pendingActions,
    ).toMatchObject([
      {
        type: Action.REVIEW_DOCUMENT,
        target: { requestId: 'request', documentId: 'file' },
      },
    ]);
  });

  for (const status of Object.values(ApplicationStatus)) {
    for (const listingStatus of Object.values(ListingStatus)) {
      it(`derives lifecycle eligibility for ${status}/${listingStatus}`, () => {
        const state = {
          ...application,
          status,
          listing: { status: listingStatus },
        };
        const mutable =
          status === ApplicationStatus.ACTIVE &&
          (listingStatus === ListingStatus.PUBLISHED ||
            listingStatus === ListingStatus.PAUSED);
        expect(applicationProcessAllowsMutation(state)).toBe(mutable);
        const result = service.derive(
          state,
          'applicant',
          conversation,
          [],
          [],
          asOf,
        );
        expect(result.pendingActionCount).toBe(mutable ? 1 : 0);
        expect(result.historicalUnreadMessageCount).toBe(2);
        expect(result.actionableUnreadMessageCount).toBe(mutable ? 2 : 0);
        expect(
          conversationResponsibility(state, ConversationSide.PROVIDER)
            .isReadOnly,
        ).toBe(!mutable);
      });
    }
  }

  it.each([
    [null, true, false],
    [
      {
        state: ApplicationDocumentState.FAILED,
        availableAt: null,
        reviewedAt: null,
      },
      true,
      false,
    ],
    [
      {
        state: ApplicationDocumentState.FAILED,
        availableAt: asOf,
        reviewedAt: null,
      },
      false,
      false,
    ],
    [
      {
        state: ApplicationDocumentState.PROCESSING,
        availableAt: null,
        reviewedAt: null,
      },
      false,
      false,
    ],
    [
      {
        state: ApplicationDocumentState.AVAILABLE,
        availableAt: asOf,
        reviewedAt: null,
      },
      false,
      true,
    ],
    [
      {
        state: ApplicationDocumentState.AVAILABLE,
        availableAt: asOf,
        reviewedAt: asOf,
      },
      false,
      false,
    ],
  ])(
    'uses document capability predicates for %j',
    (file, canUpload, canReview) => {
      expect(documentRequestCapabilities(null, file, true)).toEqual({
        canUpload,
        canReview,
      });
      expect(documentRequestCapabilities(asOf, file, true)).toEqual({
        canUpload: false,
        canReview: false,
      });
      expect(documentRequestCapabilities(null, file, false)).toEqual({
        canUpload: false,
        canReview: false,
      });
    },
  );

  it.each([
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { limit: 'oops' },
    { offset: 1.5 },
  ])('rejects invalid query %j', async (input) => {
    expect(
      await validate(plainToInstance(AttentionQueryDto, input)),
    ).not.toHaveLength(0);
  });
});
