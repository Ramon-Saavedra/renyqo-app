import { Module } from '@nestjs/common';
import { ApplicationReadModelsModule } from './application-read-models/application-read-models.module';
import { ApplicationAttentionModule } from './application-attention/application-attention.module';
import { ApplicationViewingsModule } from './application-viewings/application-viewings.module';
import { ApplicationDocumentsModule } from './application-documents/application-documents.module';
import { ApplicationConversationModule } from './application-conversation/application-conversation.module';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { ApplicantListingActionsModule } from './applicant-listing-actions/applicant-listing-actions.module';
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
    ApplicationReadModelsModule,
    PrismaModule,
    AuthModule,
    MeModule,
    ListingsModule,
    ListingAssistanceModule,
    ListingImagesModule,
    DashboardModule,
    ApplicationsModule,
    ApplicationConversationModule,
    ApplicationDocumentsModule,
    ApplicationViewingsModule,
    ApplicationAttentionModule,
    ApplicantListingActionsModule,
    ApplicantProfileModule,
    EligibilityModule,
    HealthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
