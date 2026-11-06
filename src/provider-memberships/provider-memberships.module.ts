import { Module } from '@nestjs/common';
import { MembershipLifecycle } from './membership-lifecycle';
import { MembershipRepository } from './persistence/membership.repository';
import { OwnershipTransferIntentRepository } from './persistence/ownership-transfer-intent.repository';
import { OwnershipTransferIntents } from './ownership-transfer-intents';

@Module({
  providers: [
    MembershipRepository,
    MembershipLifecycle,
    OwnershipTransferIntentRepository,
    OwnershipTransferIntents,
  ],
})
export class ProviderMembershipsModule {}
