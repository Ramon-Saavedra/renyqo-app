import { Module } from '@nestjs/common';
import { GlobalAuthorityReader } from './persistence/global-authority.reader';
import { AuthorityLockRepository } from './persistence/authority-lock.repository';
import { WorkspaceMembershipResolver } from './workspace-membership.resolver';
import { ProtectedWorkspaceTransactions } from './protected-workspace-transactions';
import { AuthorizedWorkspaceReads } from './authorized-workspace-reads';
import { WorkspaceAuthorityReader } from './persistence/workspace-authority.reader';
import { ProviderListingAccess } from './provider-listing-access';

// No controllers/exports or domain allow adapters. Integration is explicit in
// later approved callers; registering this module changes no legacy endpoint.
@Module({
  providers: [
    ProviderListingAccess,
    GlobalAuthorityReader,
    WorkspaceAuthorityReader,
    AuthorityLockRepository,
    WorkspaceMembershipResolver,
    ProtectedWorkspaceTransactions,
    AuthorizedWorkspaceReads,
  ],
  exports: [
    ProviderListingAccess,
    ProtectedWorkspaceTransactions,
    WorkspaceMembershipResolver,
  ],
})
export class ProviderAuthorizationModule {}
