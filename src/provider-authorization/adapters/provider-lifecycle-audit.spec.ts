import type { Prisma } from '../../generated/prisma/client';
import { unitContext } from '../../../test/unit-workspace-authority';
import { withListingLifecycleAudit } from '../../listings/listing-audit-boundary';
import { withApplicationLifecycleAudit } from '../../applications/application-audit-boundary';
import { projectAuditedProviderMutation } from './provider-lifecycle-audit';
import type { ProviderOperation } from '../operations/provider-operation';

jest.mock('../../listings/listing-audit-boundary', () => ({
  withListingLifecycleAudit: jest.fn(
    (
      _tx: unknown,
      _actor: unknown,
      _command: unknown,
      _id: unknown,
      work: () => Promise<unknown>,
    ) => work(),
  ),
}));
jest.mock('../../applications/application-audit-boundary', () => ({
  withApplicationLifecycleAudit: jest.fn(
    (
      _tx: unknown,
      _actor: unknown,
      _command: unknown,
      _ids: unknown,
      work: () => Promise<unknown>,
    ) => work(),
  ),
}));

describe('Provider domain Audit routing', () => {
  const tx = {} as Prisma.TransactionClient,
    context = unitContext('provider');
  beforeEach(() => jest.clearAllMocks());
  function run(operation: ProviderOperation, consequences = false) {
    return projectAuditedProviderMutation(
      tx,
      context,
      operation,
      'command',
      'listing',
      () => Promise.resolve(42),
      'application',
      consequences,
    );
  }
  it('a listing-only mutation enters no Application boundary', async () => {
    expect(await run('listing.write')).toBe(42);
    expect(withListingLifecycleAudit).toHaveBeenCalledTimes(1);
    expect(withApplicationLifecycleAudit).not.toHaveBeenCalled();
  });
  it('publication/resume and rental closing explicitly coordinate both boundaries', async () => {
    expect(await run('listing.write', true)).toBe(42);
    expect(withListingLifecycleAudit).toHaveBeenCalledTimes(1);
    expect(withApplicationLifecycleAudit).toHaveBeenCalledTimes(1);
  });
  it.each<ProviderOperation>([
    'application.reject',
    'application.restore',
    'viewing.workflow.command',
    'viewing.workflow.consideration',
  ])('%s enters only the Application boundary', async (operation) => {
    expect(await run(operation)).toBe(42);
    expect(withApplicationLifecycleAudit).toHaveBeenCalledTimes(1);
    expect(withListingLifecycleAudit).not.toHaveBeenCalled();
  });
  it.each<ProviderOperation>([
    'document.review',
    'document.request',
    'conversation.send',
    'listing.media.write',
    'listing.assignment.reassign',
    'listing.order',
    'viewing.propose',
    'viewing.respond',
    'viewing.outcome',
  ])('%s does not execute either lifecycle boundary', async (operation) => {
    expect(await run(operation)).toBe(42);
    expect(withApplicationLifecycleAudit).not.toHaveBeenCalled();
    expect(withListingLifecycleAudit).not.toHaveBeenCalled();
  });
});
