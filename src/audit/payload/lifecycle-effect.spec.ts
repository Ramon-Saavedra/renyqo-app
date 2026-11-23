import { randomUUID } from 'node:crypto';
import { validLifecycleEffect } from './lifecycle-effect';
describe('Lifecycle Audit payload privacy contract', () => {
  const listing = () => ({
    effectKey: `listing.state:${randomUUID()}`,
    transition: {
      kind: 'LISTING_STATE',
      listingId: randomUUID(),
      previousStatus: 'DRAFT',
      revisionBefore: 1,
      changedFieldNames: ['title'],
      ordering: false,
      previousPosition: 1,
    },
  });
  it('accepts only resource/state and allowlisted changed field names', () => {
    expect(validLifecycleEffect(listing())).toBe(true);
    expect(
      validLifecycleEffect({
        effectKey: `application.activity:${randomUUID()}`,
        transition: { kind: 'APPLICATION_ACTIVITY', activityId: randomUUID() },
      }),
    ).toBe(true);
  });
  it.each([
    'profile',
    'email',
    'messageBody',
    'documentUrl',
    'token',
    'priceValues',
  ])('rejects %s entity/value dumping', (key) => {
    const e = listing();
    expect(
      validLifecycleEffect({
        ...e,
        transition: { ...e.transition, [key]: 'sensitive' },
      }),
    ).toBe(false);
    expect(
      validLifecycleEffect({
        ...e,
        transition: { ...e.transition, changedFieldNames: [key] },
      }),
    ).toBe(false);
  });
  it('rejects unbounded/duplicate fields and malformed resources', () => {
    const e = listing();
    expect(
      validLifecycleEffect({
        ...e,
        transition: { ...e.transition, listingId: 'foreign-secret' },
      }),
    ).toBe(false);
    expect(
      validLifecycleEffect({
        ...e,
        transition: { ...e.transition, changedFieldNames: ['title', 'title'] },
      }),
    ).toBe(false);
  });
});
