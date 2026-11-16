import type { ProviderCapability } from '../provider-authorization/capabilities/provider-capability';
import { mapProjection } from '../provider-authorization/projections/projection-fields';
import { projectProviderDocumentActions } from '../application-documents/provider-document-action-projection';
import { projectProviderViewingActions } from '../application-viewings/provider-viewing-action-projection';
import { projectProviderConversationActions } from '../application-conversation/provider-conversation-action-projection';
import { projectProviderApplicationActions } from '../applications/provider-application-action-projection';

export function projectProviderCompositeActions(
  value: unknown,
  available: ReadonlySet<ProviderCapability>,
): unknown {
  const child = (nested: unknown) =>
    projectProviderCompositeActions(nested, available);
  return mapProjection(
    projectProviderApplicationActions(value, available),
    {},
    available,
    {
      capabilities: (nested) =>
        projectProviderApplicationActions(nested, available),
      documentsSummary: (nested) =>
        projectProviderDocumentActions(nested, available),
      viewingSummary: (nested) =>
        projectProviderViewingActions(nested, available),
      viewing: (nested) => projectProviderViewingActions(nested, available),
      conversationSummary: (nested) =>
        projectProviderConversationActions(nested, available),
      conversation: (nested) =>
        projectProviderConversationActions(nested, available),
      items: child,
      attention: child,
      activeApplications: child,
      recentExits: child,
    },
  );
}
