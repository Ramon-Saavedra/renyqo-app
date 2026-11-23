export const APPLICATION_LIFECYCLE_TYPES = [
  'application_submitted',
  'application_withdrawn',
  'application_rejected',
  'application_restored',
  'application_promoted_to_active',
  'application_accepted',
  'viewing_consideration_changed',
] as const;
export const LISTING_AUDIT_FIELDS = [
  'title',
  'street',
  'zip',
  'city',
  'district',
  'country',
  'showExactAddress',
  'objectType',
  'livingArea',
  'rooms',
  'bedrooms',
  'coldRent',
  'additionalCosts',
  'deposit',
  'depositMonths',
  'availableFrom',
  'shortDescription',
  'minimumHouseholdNetIncome',
  'schufaRequired',
  'incomeProofRequired',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
] as const;
export type ListingAuditField = (typeof LISTING_AUDIT_FIELDS)[number];
export type LifecycleTransition =
  | Readonly<{
      kind: 'LISTING_STATE';
      listingId: string;
      previousStatus:
        'DRAFT' | 'PUBLISHED' | 'PAUSED' | 'RENTED' | 'RETIRED' | null;
      revisionBefore: number | null;
      changedFieldNames: readonly ListingAuditField[];
      ordering: boolean;
      previousPosition: number | null;
    }>
  | Readonly<{ kind: 'APPLICATION_ACTIVITY'; activityId: string }>;
export type LifecycleAuditEffect = Readonly<{
  effectKey: string;
  transition: LifecycleTransition;
}>;
export type LifecycleActor =
  | {
      kind: 'MEMBER';
      context: import('../../provider-authorization/domain/authorization.types').AuthorizationContext;
    }
  | {
      kind: 'USER';
      authority: import('../../provider-authorization/domain/authorization.types').SessionAuthority;
    }
  | { kind: 'SYSTEM'; profileScopeId?: string };
export type LifecyclePayloads = {
  'application.consideration_recorded': {
    decision: import('../../generated/prisma/enums').ViewingProviderConsideration;
    workflowId: string;
    workflowRevision: number;
  };
  'provider.listing.created': {
    previousStatus: null;
    newStatus: string;
    changedFieldNames: readonly ListingAuditField[];
  };
  'provider.listing.updated': {
    previousStatus: string;
    newStatus: string;
    changedFieldNames: readonly ListingAuditField[];
  };
  'provider.listing.published': {
    previousStatus: string;
    newStatus: 'PUBLISHED';
    changedFieldNames: readonly ListingAuditField[];
  };
  'provider.listing.status_changed': {
    previousStatus: string;
    newStatus: string;
    changedFieldNames: readonly ListingAuditField[];
  };
  'provider.listing.retired': {
    previousStatus: string;
    newStatus: 'RETIRED';
    changedFieldNames: readonly ListingAuditField[];
  };
  'provider.listing.rented': {
    previousStatus: string;
    newStatus: 'RENTED';
    changedFieldNames: readonly ListingAuditField[];
    selectedApplicationId: string;
  };
  'provider.listing.order_changed': {
    previousStatus: string;
    newStatus: string;
    changedFieldNames: readonly ListingAuditField[];
    previousPosition: number;
    newPosition: number;
  };
  'application.submitted': { previousStatus: null; newStatus: string };
  'application.withdrawn': { previousStatus: string; newStatus: 'WITHDRAWN' };
  'application.rejected': { previousStatus: string; newStatus: 'REJECTED' };
  'application.restored': { previousStatus: 'REJECTED'; newStatus: string };
  'application.promoted': { previousStatus: 'WAITING'; newStatus: 'ACTIVE' };
  'application.tenant_selected': {
    previousStatus: 'ACTIVE';
    newStatus: 'ACCEPTED';
  };
};
