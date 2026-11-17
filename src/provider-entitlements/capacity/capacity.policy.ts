import { ConflictException } from '@nestjs/common';
import type { CapacitySnapshot } from '../catalog/entitlement.types';
export function capacityConflict(code: string): never {
  throw new ConflictException({ code, message: code });
}
export function assertAcquisition(
  s: CapacitySnapshot,
  kind: 'LISTING' | 'SEAT',
) {
  if (!s.assigned) capacityConflict('PLAN_UNAVAILABLE');
  if (s.overLimit.length) capacityConflict('WORKSPACE_OVER_LIMIT');
  if (kind === 'LISTING' && s.usedListings >= s.maxListings)
    capacityConflict('LISTING_LIMIT_REACHED');
  if (kind === 'SEAT' && s.acceptedSeats + s.reservedSeats >= s.maxSeats)
    capacityConflict('SEAT_LIMIT_REACHED');
}
