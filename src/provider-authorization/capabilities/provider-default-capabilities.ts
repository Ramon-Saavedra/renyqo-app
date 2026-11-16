import type { ProviderCapability } from './provider-capability';

type Membership = { role: string; status: string };

// Explicit compatibility preset: adding a future catalog entry never grants it.
const operationalAgent = Object.freeze([
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
] as const satisfies readonly ProviderCapability[]);

// FINANCIAL_READ is a reserved contract, not activated authority for either role.
// Financial/billing operations retain their OWNER-only structural rules.
export function providerDefaultCapabilities(
  member: Membership,
): ReadonlySet<ProviderCapability> {
  if (member.status !== 'ACTIVE' || !['OWNER', 'AGENT'].includes(member.role)) {
    return new Set();
  }
  return new Set(
    operationalAgent.filter(
      (capability) =>
        member.role === 'AGENT' || capability !== 'LISTING_TRANSFER_REQUEST',
    ),
  );
}
