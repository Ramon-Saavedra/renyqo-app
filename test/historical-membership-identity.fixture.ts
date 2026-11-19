import type { Prisma } from '../src/generated/prisma/client';
import { MembershipIdentityRepository } from '../src/provider-workspaces/persistence/membership-identity.repository';

// Historical foundation suites intentionally stop before the color cutover.
// Keep that historical representation in fixtures, never in production code.
export class HistoricalMembershipIdentity extends MembershipIdentityRepository {
  override async establishOwner(
    tx: Prisma.TransactionClient,
    data: Parameters<MembershipIdentityRepository['establishOwner']>[1],
  ) {
    const [{ legacy }] = await tx.$queryRaw<
      { legacy: boolean }[]
    >`SELECT character_maximum_length=7 AS legacy FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workspace_memberships' AND column_name='display_color'`;
    return super.establishOwner(tx, {
      ...data,
      displayColor: legacy ? '#2563EB' : data.displayColor,
    });
  }
}
