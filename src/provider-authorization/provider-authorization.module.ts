import { Module } from '@nestjs/common';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import { AuthorityLockRepository } from './persistence/authority-lock.repository';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from './protected-workspace-transactions';
import { AuthorizedWorkspaceReads } from './authorized-workspace-reads';
import { WorkspaceAuthorityReader } from './persistence/workspace-authority.reader';
import { ProviderListingAccess } from './provider-listing-access';
import { ActorSnapshotCapture } from '../member-presentation/actor-snapshot.capture';

// Domain adapters enter through these coordinated authorization boundaries.
// Capability evaluation reuses authoritative resolution; it grants no scope.
@Module({
  providers: [
    ActorSnapshotCapture,
    ProviderListingAccess,
    GlobalAuthorityReader,
    WorkspaceAuthorityReader,
    AuthorityLockRepository,
    WorkspaceMembershipResolver,
    ProtectedWorkspaceTransactions,
    AuthorizedWorkspaceReads,
  ],
  exports: [
    GlobalAuthorityReader,
    AuthorityLockRepository,
    AuthorizedWorkspaceReads,
    ProviderListingAccess,
    ProtectedWorkspaceTransactions,
    WorkspaceMembershipResolver,
  ],
})
export class ProviderAuthorizationModule {}
