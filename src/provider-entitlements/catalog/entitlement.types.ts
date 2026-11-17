// No commercial features have been approved. Unknown keys fail closed.
export const entitlementFeatures = [] as const;
export type EntitlementFeature = (typeof entitlementFeatures)[number];
export type FutureBillingStanding = 'PAST_DUE' | 'GRACE' | 'BILLING_RESTRICTED';
// Reserved contract only: no standing-to-action policy is activated in 4.5.7.
export interface FutureBillingPolicy {
  readonly standing: FutureBillingStanding;
}
export interface CapacitySnapshot {
  assigned: boolean;
  assignmentRevision: number;
  plan: { id: string; key: string; version: number } | null;
  maxListings: number;
  maxSeats: number;
  usedListings: number;
  acceptedSeats: number;
  reservedSeats: number;
  features: readonly EntitlementFeature[];
  overLimit: readonly ('LISTINGS' | 'SEATS')[];
}
