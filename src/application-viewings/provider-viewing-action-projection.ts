import type { ProviderCapability } from '../provider-authorization/capabilities/provider-capability';
import { allowsProviderOperation } from '../provider-authorization/capabilities/provider-capability-policy';
import {
  mapProjection,
  type Projection,
} from '../provider-authorization/projections/projection-fields';

export function projectProviderViewingActions(
  value: unknown,
  available: ReadonlySet<ProviderCapability>,
): unknown {
  const child = (nested: unknown) =>
    projectProviderViewingActions(nested, available);
  if (Array.isArray(value)) {
    const items = value.map(child);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  const projected = mapProjection(
    value,
    {
      canPropose: 'viewing.propose',
      canReschedule: 'viewing.propose',
      canCancel: 'viewing.respond',
      canMarkCompleted: 'viewing.outcome',
      canMarkNoShow: 'viewing.outcome',
      canCorrectOutcome: 'viewing.outcome',
      allowed: 'viewing.workflow.command',
    },
    available,
    {
      items: child,
      current: child,
      latest: child,
      latestCompleted: child,
      pendingInterest: child,
      changeRequested: child,
      capabilities: child,
      appointments: child,
      proposals: child,
    },
  );
  if (projected && typeof projected === 'object' && !Array.isArray(projected)) {
    const dto = projected as Projection;
    const operation =
      dto.action === 'SET_CONSIDERATION'
        ? 'viewing.workflow.consideration'
        : 'viewing.workflow.command';
    if (
      typeof dto.action === 'string' &&
      typeof dto.allowed === 'boolean' &&
      !allowsProviderOperation(available, operation)
    ) {
      return {
        ...dto,
        allowed: false,
        blockedReason: dto.blockedReason ?? 'PROVIDER_CAPABILITY_REQUIRED',
      };
    }
  }
  return projected;
}
