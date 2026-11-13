import { Module } from '@nestjs/common';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { AssignmentRepository } from './persistence/assignment.repository';
import { AssignmentParticipants } from './assignment-participants';
import { OwnerReassignment } from './owner-reassignment';
import { AgentTransferRequests } from './agent-transfer-requests';
import { ListingAssignmentsController } from './listing-assignments.controller';

@Module({
  imports: [ProviderAuthorizationModule],
  controllers: [ListingAssignmentsController],
  providers: [
    AssignmentRepository,
    AssignmentParticipants,
    OwnerReassignment,
    AgentTransferRequests,
  ],
})
export class ListingAssignmentsModule {}
