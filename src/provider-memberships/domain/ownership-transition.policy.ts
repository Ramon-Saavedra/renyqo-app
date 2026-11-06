import type { OwnershipTransferOutcome } from '../../generated/prisma/client';

// A structural plan, never authorization or a capability/scope preset.
export function ownershipTransition(outcome: OwnershipTransferOutcome) {
  return {
    formerOwner: {
      role: 'AGENT' as const,
      status:
        outcome === 'DEMOTE_TO_AGENT'
          ? ('ACTIVE' as const)
          : ('REMOVED' as const),
    },
    target: { role: 'OWNER' as const, status: 'ACTIVE' as const },
  };
}
