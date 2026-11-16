import type { ProviderCapability } from '../capabilities/provider-capability';
import { LISTING_OPERATIONS, TRANSFER_OPERATIONS } from './provider-operation';

export const listingRequirements = {
  'listing.read': ['LISTING_READ'],
  'listing.list': ['LISTING_READ', 'APPLICATION_READ'],
  'listing.write': ['LISTING_READ', 'LISTING_MANAGE'],
  'listing.count': ['LISTING_READ'],
  'listing.create': ['LISTING_READ', 'LISTING_CREATE'],
  'listing.media.read': ['LISTING_READ'],
  'listing.media.write': ['LISTING_READ', 'LISTING_MANAGE'],
  'listing.media.remove': ['LISTING_READ', 'LISTING_MANAGE'],
  // Empty allOf is deliberate: these operations retain structural OWNER checks.
  'listing.order': [],
  'listing.assignment.reassign': [],
  'listing.transfer.request': ['LISTING_TRANSFER_REQUEST'],
  'listing.transfer.cancel': ['LISTING_TRANSFER_REQUEST'],
  'listing.transfer.approve': [],
  'listing.transfer.reject': [],
} as const satisfies Record<
  (typeof LISTING_OPERATIONS)[number] | (typeof TRANSFER_OPERATIONS)[number],
  readonly ProviderCapability[]
>;
