import { Module } from '@nestjs/common';
import { ProviderWorkspacesController } from './provider-workspaces.controller';
import { WorkspaceDiscovery } from './workspace-discovery';
import { WorkspaceRepository } from './persistence/workspace.repository';
import { MembershipIdentityRepository } from './persistence/membership-identity.repository';
import { OrganizationProfileRepository } from './persistence/organization-profile.repository';
import { PersonalAllocationRepository } from './persistence/personal-allocation.repository';
import { WorkspaceEstablishment } from './workspace-establishment';
import { WorkspaceConversion } from './workspace-conversion';
import { WorkspaceLifecycle } from './workspace-lifecycle';
import { WorkspaceCreation } from '../provider-tenancy/workspace-creation';
import { TenantTransactions } from '../provider-tenancy/tenant-transactions';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { ProviderEntitlementsModule } from '../provider-entitlements/provider-entitlements.module';
import { CurrentWorkspaceQuery } from './projections/current-workspace.query';

// Discovery is read-only; establishment/conversion/lifecycle commands stay dormant.
@Module({
  imports: [ProviderAuthorizationModule, ProviderEntitlementsModule],
  controllers: [ProviderWorkspacesController],
  providers: [
    WorkspaceDiscovery,
    CurrentWorkspaceQuery,
    WorkspaceRepository,
    MembershipIdentityRepository,
    OrganizationProfileRepository,
    PersonalAllocationRepository,
    WorkspaceEstablishment,
    WorkspaceConversion,
    WorkspaceLifecycle,
    WorkspaceCreation,
    TenantTransactions,
    GlobalAuthorityReader,
    AuthorityLockRepository,
  ],
})
export class ProviderWorkspacesModule {}
