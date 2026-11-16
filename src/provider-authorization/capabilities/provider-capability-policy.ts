import { ForbiddenException } from '@nestjs/common';
import type { AuthorizationContext } from '../domain/authorization.types';
import {
  isProviderCapability,
  type ProviderCapability,
} from './provider-capability';
import { providerDefaultCapabilities } from './provider-default-capabilities';
import {
  isProviderOperation,
  PROVIDER_OPERATION_REQUIREMENTS,
} from '../operations/provider-operation-requirements';

export function allowsProviderOperation(
  available: ReadonlySet<ProviderCapability>,
  operation: unknown,
): boolean {
  return (
    isProviderOperation(operation) &&
    [...available].every(isProviderCapability) &&
    PROVIDER_OPERATION_REQUIREMENTS[operation].every((capability) =>
      available.has(capability),
    )
  );
}

// Only authoritative server-observed membership facts enter this adapter.
export function assertProviderOperation(
  context: AuthorizationContext,
  operation: unknown,
): void {
  if (
    context.status !== 'ACTIVE' ||
    !['OWNER', 'AGENT'].includes(context.role) ||
    !allowsProviderOperation(providerDefaultCapabilities(context), operation)
  ) {
    throw new ForbiddenException('Provider capability required');
  }
}
