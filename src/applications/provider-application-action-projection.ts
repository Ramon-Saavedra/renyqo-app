import type { ProviderCapability } from '../provider-authorization/capabilities/provider-capability';
import { mapProjection } from '../provider-authorization/projections/projection-fields';

export function projectProviderApplicationActions(
  value: unknown,
  available: ReadonlySet<ProviderCapability>,
): unknown {
  return mapProjection(
    value,
    {
      canReject: 'application.reject',
      canRestore: 'application.restore',
      // Rental selection invokes the Listing rent command, not application curation.
      canSelectForRental: 'listing.write',
    },
    available,
  );
}
