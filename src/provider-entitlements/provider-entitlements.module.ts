import { Module } from '@nestjs/common';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { EntitlementResolver } from './resolution/entitlement-resolver';
import { WorkspacePlanCommands } from './assignments/workspace-plan.commands';
import { SeatReservations } from './capacity/seat-reservations';
import { WorkspaceCapacityQuery } from './projections/workspace-capacity.query';
import { MockPlanActivation } from './adapters/mock-plan-activation';
import { EntitlementsController } from './adapters/entitlements.controller';
import { ListingCreationAvailabilityProjection } from './projections/listing-creation-availability';
@Module({
  imports: [ProviderAuthorizationModule],
  controllers: [EntitlementsController],
  providers: [
    EntitlementResolver,
    ListingCreationAvailabilityProjection,
    WorkspacePlanCommands,
    SeatReservations,
    WorkspaceCapacityQuery,
    MockPlanActivation,
  ],
  exports: [
    EntitlementResolver,
    SeatReservations,
    ListingCreationAvailabilityProjection,
  ],
})
export class ProviderEntitlementsModule {}
