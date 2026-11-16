import type { ProviderCapability } from '../provider-authorization/capabilities/provider-capability';
import { mapProjection } from '../provider-authorization/projections/projection-fields';

export function projectProviderDocumentActions(
  value: unknown,
  available: ReadonlySet<ProviderCapability>,
): unknown {
  const child = (nested: unknown) =>
    projectProviderDocumentActions(nested, available);
  return mapProjection(
    value,
    {
      canDownload: 'document.content.read',
      canReview: 'document.review',
      canCancel: 'document.cancel',
      canRequestReplacement: 'document.replace',
      canReRequest: 'document.request',
      canRequestRequirements: 'document.request',
      canRequestDocuments: 'document.request',
    },
    available,
    {
      documents: child,
      currentRequests: child,
      items: child,
      capabilities: child,
      evidence: child,
      files: child,
    },
  );
}
