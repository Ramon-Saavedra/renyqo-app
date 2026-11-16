import type { ProviderOperation } from './provider-operation';

export const TRANSFER_RESPONSE_OPERATIONS = Object.freeze({
  APPROVED: 'listing.transfer.approve',
  REJECTED: 'listing.transfer.reject',
  CANCELLED: 'listing.transfer.cancel',
} as const satisfies Record<
  'APPROVED' | 'REJECTED' | 'CANCELLED',
  ProviderOperation
>);
