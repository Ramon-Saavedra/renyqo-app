import { Module } from '@nestjs/common';
import { ProviderAuthorizationModule } from '../provider-authorization/provider-authorization.module';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { ApplicantListingAccess } from './applicant-listing-access';
import { ApplicationListingAccess } from './application-listing-access';

@Module({
  imports: [ProviderAuthorizationModule],
  providers: [
    GlobalAuthorityReader,
    AuthorityLockRepository,
    ApplicantListingAccess,
    ApplicationListingAccess,
  ],
  exports: [ApplicantListingAccess, ApplicationListingAccess],
})
export class ListingConsumerAccessModule {}
