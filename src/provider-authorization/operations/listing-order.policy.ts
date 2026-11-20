import type { AuthorizationContext } from '../domain/authorization.types';
import { allowsProviderOperation } from '../capabilities/provider-capability-policy';
import { providerDefaultCapabilities } from '../capabilities/provider-default-capabilities';

// Workspace-wide ordering remains structural OWNER authority, not a grantable
// AGENT capability. Both the advisory projection and protected mutation use this.
export function canReorderListings(context: AuthorizationContext): boolean {
  return (
    context.status === 'ACTIVE' &&
    context.workspaceLifecycle === 'ACTIVE' &&
    context.role === 'OWNER' &&
    allowsProviderOperation(
      providerDefaultCapabilities(context),
      'listing.order',
    )
  );
}
