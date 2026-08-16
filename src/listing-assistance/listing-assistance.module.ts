import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { EnvironmentVariables } from '../config/env.validation';
import { ProviderAiThrottlerGuard } from './guards/provider-ai-throttler.guard';
import { ListingAssistanceController } from './listing-assistance.controller';
import { ListingAssistanceService } from './listing-assistance.service';
import { AI_PROVIDER } from './providers/ai-provider.token';
import { OpenAiProvider } from './providers/openai.provider';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => [
        {
          name: 'aiText',
          ttl: config.getOrThrow('AI_RATE_LIMIT_WINDOW_MS', { infer: true }),
          limit: config.getOrThrow('AI_TEXT_RATE_LIMIT', { infer: true }),
        },
        {
          name: 'aiPdf',
          ttl: config.getOrThrow('AI_RATE_LIMIT_WINDOW_MS', { infer: true }),
          limit: config.getOrThrow('AI_PDF_RATE_LIMIT', { infer: true }),
        },
        {
          name: 'aiAudio',
          ttl: config.getOrThrow('AI_RATE_LIMIT_WINDOW_MS', { infer: true }),
          limit: config.getOrThrow('AI_AUDIO_RATE_LIMIT', { infer: true }),
        },
      ],
    }),
  ],
  controllers: [ListingAssistanceController],
  providers: [
    ListingAssistanceService,
    ProviderAiThrottlerGuard,
    OpenAiProvider,
    { provide: AI_PROVIDER, useExisting: OpenAiProvider },
  ],
})
export class ListingAssistanceModule {}
