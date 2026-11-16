export const PROVIDER_CAPABILITIES = Object.freeze([
  'LISTING_READ',
  'LISTING_MANAGE',
  'LISTING_CREATE',
  'APPLICATION_READ',
  'APPLICATION_MANAGE',
  'VIEWING_READ',
  'VIEWING_MANAGE',
  'DOCUMENT_READ',
  'DOCUMENT_CONTENT_READ',
  'DOCUMENT_REQUEST',
  'DOCUMENT_REVIEW',
  'VERIFICATION_MANAGE',
  'CONVERSATION_READ',
  'CONVERSATION_MANAGE',
  'LISTING_TRANSFER_REQUEST',
  'FINANCIAL_READ',
] as const);

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export function isProviderCapability(
  value: unknown,
): value is ProviderCapability {
  return PROVIDER_CAPABILITIES.some((capability) => capability === value);
}
