import { assertAcquisition } from './capacity.policy';
import type { CapacitySnapshot } from '../catalog/entitlement.types';
const base: CapacitySnapshot = {
  assigned: true,
  assignmentRevision: 1,
  plan: null,
  maxListings: 2,
  maxSeats: 3,
  usedListings: 1,
  acceptedSeats: 1,
  reservedSeats: 1,
  features: [],
  overLimit: [],
};
describe('Capacity is independent from actor capability/scope', () => {
  it('permits an available acquisition', () =>
    expect(() => assertAcquisition(base, 'LISTING')).not.toThrow());
  it.each([
    [{ ...base, assigned: false }, 'PLAN_UNAVAILABLE'],
    [{ ...base, overLimit: ['SEATS'] as const }, 'WORKSPACE_OVER_LIMIT'],
    [{ ...base, usedListings: 2 }, 'LISTING_LIMIT_REACHED'],
  ])('rejects unavailable listing capacity %#', (value, code) => {
    try {
      assertAcquisition(value, 'LISTING');
      throw new Error('Expected denial');
    } catch (error) {
      expect(
        (error as { getResponse: () => unknown }).getResponse(),
      ).toMatchObject({ code });
    }
  });
  it('counts accepted and reserved seats together', () =>
    expect(() => assertAcquisition({ ...base, maxSeats: 2 }, 'SEAT')).toThrow(
      'SEAT_LIMIT_REACHED',
    ));
});
