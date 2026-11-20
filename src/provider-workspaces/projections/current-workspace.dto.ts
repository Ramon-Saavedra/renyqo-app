import type {
  WorkspaceKind,
  WorkspaceMembershipRole,
} from '../../generated/prisma/client';
import type { MemberColor } from '../../member-presentation/member-color.catalog';
import type { ListingCreationAvailability } from '../../provider-entitlements/projections/listing-creation-availability';

export type CurrentWorkspaceDto = {
  workspace: { id: string; displayName: string; kind: WorkspaceKind };
  membership: {
    id: string;
    role: WorkspaceMembershipRole;
    colorId: MemberColor;
  };
  actions: {
    createListing: ListingCreationAvailability;
    reorderListings: { allowed: boolean };
  };
};
