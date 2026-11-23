import { auditsApplicationLifecycle } from './application-audit-operations';
import type { ProviderOperation } from '../provider-authorization/operations/provider-operation';

describe('Explicit Application lifecycle Audit operations', () => {
  it.each<ProviderOperation>([
    'application.reject',
    'application.restore',
    'application.promote',
    'viewing.workflow.command',
    'viewing.workflow.consideration',
  ])('retains lifecycle evidence for %s', (operation) => {
    expect(auditsApplicationLifecycle(operation)).toBe(true);
  });
  it.each<ProviderOperation>([
    'listing.write',
    'listing.order',
    'listing.media.write',
    'listing.assignment.reassign',
    'document.request',
    'document.review',
    'verification.decide',
    'conversation.send',
    'conversation.mark-read',
    'viewing.propose',
    'viewing.respond',
    'viewing.outcome',
  ])('does not scan Applications for %s', (operation) => {
    expect(auditsApplicationLifecycle(operation)).toBe(false);
  });
});
