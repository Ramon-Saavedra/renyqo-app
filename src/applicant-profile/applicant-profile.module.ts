import { Module } from '@nestjs/common';

import { ApplicationsModule } from '../applications/applications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicantProfileController } from './applicant-profile.controller';
import { ApplicantProfileService } from './applicant-profile.service';

@Module({
  imports: [PrismaModule, ApplicationsModule],
  controllers: [ApplicantProfileController],
  providers: [ApplicantProfileService],
})
export class ApplicantProfileModule {}
