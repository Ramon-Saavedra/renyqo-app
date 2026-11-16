import type { ProviderOperation } from '../operations/provider-operation';
import type { ProviderCapability } from '../capabilities/provider-capability';
import { allowsProviderOperation } from '../capabilities/provider-capability-policy';

export type Projection = Record<string, unknown>;
export type ProjectionMapper = (value: unknown) => unknown;

// Visit only explicitly owned DTO children. Never traverse activity payloads,
// message bodies, user data, streams or arbitrary objects by field-name matching.
export function mapProjection(
  value: unknown,
  flags: Readonly<Record<string, ProviderOperation>>,
  available: ReadonlySet<ProviderCapability>,
  children: Readonly<Record<string, ProjectionMapper>> = {},
): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      mapProjection(item, flags, available, children),
    );
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!value || typeof value !== 'object' || value instanceof Date)
    return value;
  const source = value as Projection;
  let result = source;
  const set = (key: string, next: unknown) => {
    if (next === source[key]) return;
    if (result === source) {
      const prototype = Object.getPrototypeOf(value) as object | null;
      result = Object.assign(Object.create(prototype) as Projection, source);
    }
    result[key] = next;
  };
  for (const [key, operation] of Object.entries(flags)) {
    if (typeof source[key] === 'boolean')
      set(key, source[key] && allowsProviderOperation(available, operation));
  }
  for (const [key, mapper] of Object.entries(children)) {
    if (Object.hasOwn(source, key)) set(key, mapper(source[key]));
  }
  return result;
}
