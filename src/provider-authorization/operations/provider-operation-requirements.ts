import type { ProviderCapability } from '../capabilities/provider-capability';
import type { ProviderOperation } from './provider-operation';
import { listingRequirements } from './listing-requirements';
import { applicationRequirements } from './application-requirements';
import { domainRequirements } from './domain-requirements';

const requirements = {
  ...listingRequirements,
  ...applicationRequirements,
  ...domainRequirements,
} satisfies Record<ProviderOperation, readonly ProviderCapability[]>;
for (const allOf of Object.values(requirements)) Object.freeze(allOf);
export const PROVIDER_OPERATION_REQUIREMENTS = Object.freeze(requirements);

export function isProviderOperation(
  value: unknown,
): value is ProviderOperation {
  return (
    typeof value === 'string' &&
    Object.hasOwn(PROVIDER_OPERATION_REQUIREMENTS, value)
  );
}
