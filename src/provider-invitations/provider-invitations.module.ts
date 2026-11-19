import { Module } from '@nestjs/common';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { ProviderEntitlementsModule } from '../provider-entitlements/provider-entitlements.module';
import { EmailModule } from '../email/email.module';
import { TenantTransactions } from '../provider-tenancy/tenant-transactions';
import { SecurityLinkPolicy } from '../security/security-link-policy';
import { SecurityLinkTrafficGuard } from '../security/security-link-traffic.guard';
import { InvitationRepository } from './persistence/invitation.repository';
import { InvitationLifecycle } from './domain/invitation-lifecycle';
import { InvitationDelivery } from './delivery/invitation-delivery';
import { OwnerInvitations } from './commands/owner-invitations';
import { InviteeInvitations } from './commands/invitee-invitations';
import { TeamQuery } from './projections/team.query';
import { MemberPaletteQuery } from './projections/member-palette.query';
import { OwnerInvitationsController } from './http/owner-invitations.controller';
import { InviteeInvitationsController } from './http/invitee-invitations.controller';
@Module({
  imports: [
    ProviderAuthorizationModule,
    ProviderEntitlementsModule,
    EmailModule,
  ],
  controllers: [OwnerInvitationsController, InviteeInvitationsController],
  providers: [
    MemberPaletteQuery,
    TenantTransactions,
    SecurityLinkPolicy,
    SecurityLinkTrafficGuard,
    InvitationRepository,
    InvitationLifecycle,
    InvitationDelivery,
    OwnerInvitations,
    InviteeInvitations,
    TeamQuery,
  ],
})
export class ProviderInvitationsModule {}
