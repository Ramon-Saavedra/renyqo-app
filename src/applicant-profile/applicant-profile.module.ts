import { Module } from '@nestjs/common';

import { ApplicationsModule } from '../applications/applications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicantProfileController } from './applicant-profile.controller';
import { ApplicantProfileService } from './applicant-profile.service';
import { ProfileRevalidationTransactions } from './profile-revalidation-transactions';
import { AuthorityLockRepository } from '../provider-authorization/persistence/authority-lock.repository';
import { GlobalAuthorityReader } from '../provider-authorization/persistence/global-authority.reader';

@Module({
  imports: [PrismaModule, ApplicationsModule],
  controllers: [ApplicantProfileController],
  providers: [
    ApplicantProfileService,
    ProfileRevalidationTransactions,
    AuthorityLockRepository,
    GlobalAuthorityReader,
  ],
})
export class ApplicantProfileModule {}
