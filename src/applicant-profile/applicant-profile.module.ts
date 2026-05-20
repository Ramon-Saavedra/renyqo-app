import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ApplicantProfileController } from './applicant-profile.controller';
import { ApplicantProfileService } from './applicant-profile.service';

@Module({
  imports: [PrismaModule],
  controllers: [ApplicantProfileController],
  providers: [ApplicantProfileService],
})
export class ApplicantProfileModule {}
