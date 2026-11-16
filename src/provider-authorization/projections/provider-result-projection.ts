import type { AuthorizationContext } from '../domain/authorization.types';
import type { ProviderOperation } from '../operations/provider-operation';
import { providerDefaultCapabilities } from '../capabilities/provider-default-capabilities';
import { projectProviderDocumentActions } from '../../application-documents/provider-document-action-projection';
import { projectProviderViewingActions } from '../../application-viewings/provider-viewing-action-projection';
import { projectProviderConversationActions } from '../../application-conversation/provider-conversation-action-projection';
import { projectProviderCompositeActions } from '../../application-read-models/provider-composite-action-projection';

// Adapts authorized provider responses only; applicant projections are unchanged.
export function projectProviderResult<T>(
  value: T,
  context: AuthorizationContext,
  operation: ProviderOperation,
): T {
  if (operation === 'document.content.read') return value;
  const available = providerDefaultCapabilities(context);
  const project =
    operation.startsWith('document.') ||
    operation.startsWith('verification.') ||
    operation === 'application.document-history' ||
    operation === 'application.file-history'
      ? projectProviderDocumentActions
      : operation.startsWith('viewing.')
        ? projectProviderViewingActions
        : operation.startsWith('conversation.')
          ? projectProviderConversationActions
          : projectProviderCompositeActions;
  // These projectors retain DTO prototypes/shape; only owned action flags change.
  return project(value, available) as T;
}
