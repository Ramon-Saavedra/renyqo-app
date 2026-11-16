import type { ProviderCapability } from '../capabilities/provider-capability';
import {
  APPLICATION_OPERATIONS,
  COMPOSITE_OPERATIONS,
} from './provider-operation';

const attention = [
  'APPLICATION_READ',
  'DOCUMENT_READ',
  'VIEWING_READ',
  'CONVERSATION_READ',
] as const;
export const applicationRequirements = {
  'application.read': ['APPLICATION_READ'],
  'applications.read': ['APPLICATION_READ'],
  'applications.waiting-count': ['APPLICATION_READ'],
  'applications.active': attention,
  'applications.exited': ['APPLICATION_READ'],
  'application.reject': ['APPLICATION_READ', 'APPLICATION_MANAGE'],
  'application.restore': ['APPLICATION_READ', 'APPLICATION_MANAGE'],
  'application.promote': ['APPLICATION_READ', 'APPLICATION_MANAGE'],
  'application.activity.read': ['APPLICATION_READ'],
  'application.workspace': attention,
  'attention.read': attention,
  'attention.listings': ['LISTING_READ', ...attention],
  'attention.batch': ['LISTING_READ', ...attention],
  'listing.overview': ['LISTING_READ', ...attention],
  'listing.application-overview': ['LISTING_READ', ...attention],
  'application.document-history': ['APPLICATION_READ', 'DOCUMENT_READ'],
  'application.file-history': ['APPLICATION_READ', 'DOCUMENT_READ'],
} as const satisfies Record<
  | (typeof APPLICATION_OPERATIONS)[number]
  | (typeof COMPOSITE_OPERATIONS)[number],
  readonly ProviderCapability[]
>;
