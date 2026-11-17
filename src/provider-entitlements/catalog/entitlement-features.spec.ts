import { resolveFeatures } from './entitlement-features';
describe('Approved entitlement feature catalog', () => {
  it('preserves the empty approved feature set as immutable', () => {
    const features = resolveFeatures([]);
    expect(features).toEqual([]);
    expect(Object.isFrozen(features)).toBe(true);
  });
  it('fails closed for unknown or capability-shaped feature keys', () => {
    for (const key of ['LISTING_MANAGE', 'paid_team_package'])
      expect(() => resolveFeatures([key])).toThrow(
        'Unsupported entitlement feature',
      );
  });
});
