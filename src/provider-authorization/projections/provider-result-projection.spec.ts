import type { ProviderCapability } from '../capabilities/provider-capability';
import { PROVIDER_CAPABILITIES } from '../capabilities/provider-capability';
import { projectProviderDocumentActions } from '../../application-documents/provider-document-action-projection';
import { projectProviderViewingActions } from '../../application-viewings/provider-viewing-action-projection';
import { projectProviderConversationActions } from '../../application-conversation/provider-conversation-action-projection';
import { projectProviderApplicationActions } from '../../applications/provider-application-action-projection';
import { projectProviderCompositeActions } from '../../application-read-models/provider-composite-action-projection';

const readOnly = new Set<ProviderCapability>([
  'APPLICATION_READ',
  'DOCUMENT_READ',
  'VIEWING_READ',
  'CONVERSATION_READ',
  'LISTING_READ',
]);
const all = new Set(PROVIDER_CAPABILITIES);

describe('Provider action projection policy', () => {
  it('masks document actions including nested file/evidence metadata without changing data', () => {
    const value = {
      canRequestDocuments: true,
      currentRequests: [
        {
          canReview: true,
          canCancel: true,
          documents: [{ id: 'file', canDownload: true }],
        },
      ],
    };
    expect(projectProviderDocumentActions(value, readOnly)).toEqual({
      canRequestDocuments: false,
      currentRequests: [
        {
          canReview: false,
          canCancel: false,
          documents: [{ id: 'file', canDownload: false }],
        },
      ],
    });
    expect(value.canRequestDocuments).toBe(true);
  });
  it('does not enable domain-ineligible actions when the capability exists', () => {
    const value = { canReview: false, canDownload: false, canCancel: false };
    expect(projectProviderDocumentActions(value, all)).toBe(value);
  });
  it('masks both legacy viewing booleans and workflow action records', () => {
    expect(
      projectProviderViewingActions(
        {
          canPropose: true,
          current: { capabilities: { canMarkNoShow: true } },
          capabilities: [
            { action: 'INVITE', allowed: true, blockedReason: null },
          ],
        },
        readOnly,
      ),
    ).toEqual({
      canPropose: false,
      current: { capabilities: { canMarkNoShow: false } },
      capabilities: [
        {
          action: 'INVITE',
          allowed: false,
          blockedReason: 'PROVIDER_CAPABILITY_REQUIRED',
        },
      ],
    });
  });
  it('masks sending/reply management but preserves conversation data', () => {
    expect(
      projectProviderConversationActions(
        {
          canCurrentUserSend: true,
          canCurrentUserManageApplicantReplies: true,
          lastMessage: { body: 'message' },
        },
        readOnly,
      ),
    ).toEqual({
      canCurrentUserSend: false,
      canCurrentUserManageApplicantReplies: false,
      lastMessage: { body: 'message' },
    });
  });
  it('does not advertise application rejection through viewing consideration', () => {
    const viewingManager = new Set<ProviderCapability>([
      'APPLICATION_READ',
      'VIEWING_READ',
      'VIEWING_MANAGE',
    ]);
    expect(
      projectProviderViewingActions(
        {
          capabilities: [
            { action: 'INVITE', allowed: true, blockedReason: null },
            { action: 'SET_CONSIDERATION', allowed: true, blockedReason: null },
          ],
        },
        viewingManager,
      ),
    ).toEqual({
      capabilities: [
        { action: 'INVITE', allowed: true, blockedReason: null },
        {
          action: 'SET_CONSIDERATION',
          allowed: false,
          blockedReason: 'PROVIDER_CAPABILITY_REQUIRED',
        },
      ],
    });
  });
  it('uses the Listing rent authority for rental selection', () => {
    const flags = {
      canReject: true,
      canRestore: true,
      canSelectForRental: true,
    };
    const available = new Set(readOnly);
    available.add('APPLICATION_MANAGE');
    expect(projectProviderApplicationActions(flags, available)).toEqual({
      canReject: true,
      canRestore: true,
      canSelectForRental: false,
    });
  });
  it('adapts explicit composite sections without rewriting historical payloads', () => {
    const payload = { canReview: true, canReject: true };
    const value = {
      capabilities: { canRestore: true },
      documentsSummary: { canRequestDocuments: true },
      conversationSummary: { canCurrentUserSend: true },
      viewingSummary: { canPropose: true },
      activityPreview: { items: [{ payload }] },
    };
    expect(projectProviderCompositeActions(value, readOnly)).toEqual({
      ...value,
      capabilities: { canRestore: false },
      documentsSummary: { canRequestDocuments: false },
      conversationSummary: { canCurrentUserSend: false },
      viewingSummary: { canPropose: false },
    });
    expect(value.activityPreview.items[0].payload).toBe(payload);
  });
  it('preserves DTO identity/prototypes and rich values when nothing changes', () => {
    class Dto {
      canRestore = true;
    }
    const value = new Dto();
    expect(projectProviderApplicationActions(value, all)).toBe(value);
    expect(projectProviderApplicationActions(value, readOnly)).toBeInstanceOf(
      Dto,
    );
    const map = new Map([['id', 1]]);
    expect(projectProviderCompositeActions(map, readOnly)).toBe(map);
  });
});
