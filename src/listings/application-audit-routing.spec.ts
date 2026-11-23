import { ApplicationListingAccess } from './application-listing-access';
import type { ProviderListingAccess } from '../provider-authorization/provider-listing-access';
import type { ApplicantListingAccess } from './applicant-listing-access';
import type { ProviderOperation } from '../provider-authorization/operations/provider-operation';
import { unitSession } from '../../test/unit-workspace-authority';

describe('Applicant lifecycle Audit routing', () => {
  const mutation = jest.fn<Promise<number>, unknown[]>(() =>
    Promise.resolve(42),
  );
  const access = new ApplicationListingAccess(
    {} as ProviderListingAccess,
    { mutateApplication: mutation } as unknown as ApplicantListingAccess,
  );
  beforeEach(() => jest.clearAllMocks());
  function run(operation: ProviderOperation, lifecycle = false) {
    return access.mutate(
      unitSession('applicant'),
      'applicant',
      'application',
      () => Promise.resolve(),
      () => Promise.resolve(42),
      operation,
      { applicationLifecycle: lifecycle },
    );
  }
  it.each<ProviderOperation>([
    'document.request',
    'conversation.send',
    'viewing.respond',
    'viewing.propose',
  ])(
    '%s does not scan Applications without a lifecycle consequence',
    async (operation) => {
      expect(await run(operation)).toBe(42);
      expect(mutation.mock.calls.at(-1)?.at(4)).toEqual({
        applicationLifecycle: false,
      });
    },
  );
  it('the legacy interest-withdrawal path explicitly retains required evidence', async () => {
    await run('viewing.respond', true);
    expect(mutation.mock.calls.at(-1)?.at(4)).toEqual({
      applicationLifecycle: true,
    });
  });
  it('workflow expiry cannot opt out of its required Application boundary', async () => {
    await run('viewing.workflow.command', false);
    expect(mutation.mock.calls.at(-1)?.at(4)).toEqual({
      applicationLifecycle: true,
    });
  });
});
