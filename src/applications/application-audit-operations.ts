import type { ProviderOperation } from '../provider-authorization/operations/provider-operation';

// Server-selected operations that can durably change Application lifecycle.
// Workflow commands may also reconcile expired interest before their own action.
export function auditsApplicationLifecycle(operation: ProviderOperation) {
  return (
    operation === 'application.reject' ||
    operation === 'application.restore' ||
    operation === 'application.promote' ||
    operation === 'viewing.workflow.command' ||
    operation === 'viewing.workflow.consideration'
  );
}
