import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { ApplicantProfileModule } from './applicant-profile/applicant-profile.module';
import { ApplicationsModule } from './applications/applications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { ListingsModule } from './listings/listings.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MeModule } from './me/me.module';

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
    DashboardModule,
    ApplicationsModule,
    ApplicantProfileModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
