import type { ProviderCapability } from '../capabilities/provider-capability';
import {
  DOCUMENT_OPERATIONS,
  VIEWING_OPERATIONS,
  CONVERSATION_OPERATIONS,
} from './provider-operation';

const documents = ['APPLICATION_READ', 'DOCUMENT_READ'] as const;
const viewings = ['APPLICATION_READ', 'VIEWING_READ'] as const;
const conversation = ['APPLICATION_READ', 'CONVERSATION_READ'] as const;
export const domainRequirements = {
  'document.read': documents,
  'document.content.read': [...documents, 'DOCUMENT_CONTENT_READ'],
  'document.review': [...documents, 'DOCUMENT_REVIEW'],
  'document.request': [...documents, 'DOCUMENT_REQUEST'],
  'document.cancel': [...documents, 'DOCUMENT_REQUEST'],
  'document.replace': [...documents, 'DOCUMENT_REQUEST'],
  'verification.subjects.read': documents,
  'verification.requirements.read': documents,
  'verification.subject.write': [...documents, 'VERIFICATION_MANAGE'],
  'verification.decide': [...documents, 'VERIFICATION_MANAGE'],
  'viewing.read': viewings,
  'viewing.propose': [...viewings, 'VIEWING_MANAGE'],
  'viewing.respond': [...viewings, 'VIEWING_MANAGE'],
  'viewing.outcome': [...viewings, 'VIEWING_MANAGE'],
  'viewing.workflow.read': viewings,
  'viewing.workflow.history': viewings,
  'viewing.workflow.command': [...viewings, 'VIEWING_MANAGE'],
  // DO_NOT_CONTINUE invokes application curation, not merely appointment edits.
  'viewing.workflow.consideration': [
    ...viewings,
    'VIEWING_MANAGE',
    'APPLICATION_MANAGE',
  ],
  'conversation.read': conversation,
  'conversation.send': [...conversation, 'CONVERSATION_MANAGE'],
  'conversation.mark-read': conversation,
  'conversation.manage-replies': [...conversation, 'CONVERSATION_MANAGE'],
} as const satisfies Record<
  | (typeof DOCUMENT_OPERATIONS)[number]
  | (typeof VIEWING_OPERATIONS)[number]
  | (typeof CONVERSATION_OPERATIONS)[number],
  readonly ProviderCapability[]
>;
