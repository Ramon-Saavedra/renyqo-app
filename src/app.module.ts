import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { ApplicantProfileModule } from './applicant-profile/applicant-profile.module';
import { ApplicationsModule } from './applications/applications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { ListingImagesModule } from './listing-images/listing-images.module';
import { ListingsModule } from './listings/listings.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { EligibilityModule } from './eligibility/eligibility.module';
import { MeModule } from './me/me.module';
import { ListingAssistanceModule } from './listing-assistance/listing-assistance.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    MeModule,
    ListingsModule,
    ListingAssistanceModule,
    ListingImagesModule,
    DashboardModule,
    ApplicationsModule,
    ApplicantProfileModule,
    EligibilityModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
