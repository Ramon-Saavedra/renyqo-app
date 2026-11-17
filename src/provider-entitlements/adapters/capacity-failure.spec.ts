import { translateCapacityFailure } from './capacity-failure';
describe('Named entitlement database failures', () => {
  it.each([
    'LISTING_LIMIT_REACHED',
    'SEAT_LIMIT_REACHED',
    'DOWNGRADE_BLOCKED',
    'PLAN_UNAVAILABLE',
  ])('translates nested %s only', (message) => {
    expect(() =>
      translateCapacityFailure({
        meta: {
          driverAdapterError: {
            cause: { originalCode: '23514', originalMessage: message },
          },
        },
      }),
    ).toThrow(message);
  });
  it('returns a conflict for an expected ownership revision race', () => {
    try {
      translateCapacityFailure({
        code: '23514',
        message: 'Ownership revision changed',
      });
    } catch (error) {
      expect((error as { getStatus: () => number }).getStatus()).toBe(409);
    }
  });
  it('preserves unrelated integrity failures', () => {
    const error = { code: '23514', message: 'unrelated invariant' };
    try {
      translateCapacityFailure(error);
    } catch (actual) {
      expect(actual).toBe(error);
    }
  });
});
