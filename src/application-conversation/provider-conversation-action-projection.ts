import type { ProviderCapability } from '../provider-authorization/capabilities/provider-capability';
import { mapProjection } from '../provider-authorization/projections/projection-fields';

export function projectProviderConversationActions(
  value: unknown,
  available: ReadonlySet<ProviderCapability>,
): unknown {
  return mapProjection(
    value,
    {
      canCurrentUserSend: 'conversation.send',
      canCurrentUserManageApplicantReplies: 'conversation.manage-replies',
    },
    available,
  );
}
