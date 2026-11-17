import {
  entitlementFeatures,
  type EntitlementFeature,
} from './entitlement.types';

// Adding a feature requires an approved typed key and matching catalog migration.
export function resolveFeatures(
  values: readonly string[],
): readonly EntitlementFeature[] {
  for (const value of values)
    if (!(entitlementFeatures as readonly string[]).includes(value))
      throw new Error('Unsupported entitlement feature in published plan');
  return Object.freeze([...values]) as readonly EntitlementFeature[];
}
