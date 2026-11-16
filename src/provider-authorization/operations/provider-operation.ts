export const LISTING_OPERATIONS = [
  'listing.read',
  'listing.list',
  'listing.write',
  'listing.count',
  'listing.create',
  'listing.media.read',
  'listing.media.write',
  'listing.media.remove',
  'listing.order',
  'listing.assignment.reassign',
] as const;
export const APPLICATION_OPERATIONS = [
  'application.read',
  'applications.read',
  'applications.waiting-count',
  'applications.active',
  'applications.exited',
  'application.reject',
  'application.restore',
  'application.promote',
  'application.activity.read',
] as const;
export const DOCUMENT_OPERATIONS = [
  'document.read',
  'document.content.read',
  'document.review',
  'document.request',
  'document.cancel',
  'document.replace',
  'verification.subjects.read',
  'verification.requirements.read',
  'verification.subject.write',
  'verification.decide',
] as const;
export const VIEWING_OPERATIONS = [
  'viewing.read',
  'viewing.propose',
  'viewing.respond',
  'viewing.outcome',
  'viewing.workflow.read',
  'viewing.workflow.history',
  'viewing.workflow.command',
  'viewing.workflow.consideration',
] as const;
export const CONVERSATION_OPERATIONS = [
  'conversation.read',
  'conversation.send',
  'conversation.mark-read',
  'conversation.manage-replies',
] as const;
export const COMPOSITE_OPERATIONS = [
  'application.workspace',
  'attention.read',
  'attention.listings',
  'attention.batch',
  'listing.overview',
  'listing.application-overview',
  'application.document-history',
  'application.file-history',
] as const;
export const TRANSFER_OPERATIONS = [
  'listing.transfer.request',
  'listing.transfer.cancel',
  'listing.transfer.approve',
  'listing.transfer.reject',
] as const;
export type ProviderOperation =
  | (typeof LISTING_OPERATIONS)[number]
  | (typeof APPLICATION_OPERATIONS)[number]
  | (typeof DOCUMENT_OPERATIONS)[number]
  | (typeof VIEWING_OPERATIONS)[number]
  | (typeof CONVERSATION_OPERATIONS)[number]
  | (typeof COMPOSITE_OPERATIONS)[number]
  | (typeof TRANSFER_OPERATIONS)[number];
