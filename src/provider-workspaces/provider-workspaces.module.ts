import { Module } from '@nestjs/common';
import { WorkspaceRepository } from './persistence/workspace.repository';
import { MembershipIdentityRepository } from './persistence/membership-identity.repository';
import { OrganizationProfileRepository } from './persistence/organization-profile.repository';
import { PersonalAllocationRepository } from './persistence/personal-allocation.repository';
import { WorkspaceEstablishment } from './workspace-establishment';
import { WorkspaceConversion } from './workspace-conversion';
import { WorkspaceLifecycle } from './workspace-lifecycle';

// Deliberately no controllers or exports: dormant until the assigned security,
// audit, entitlement and cutover phases supply real operational orchestration.
@Module({
  providers: [
    WorkspaceRepository,
    MembershipIdentityRepository,
    OrganizationProfileRepository,
    PersonalAllocationRepository,
    WorkspaceEstablishment,
    WorkspaceConversion,
    WorkspaceLifecycle,
  ],
})
export class ProviderWorkspacesModule {}
