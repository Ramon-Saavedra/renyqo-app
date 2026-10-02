import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApplicationDocumentConfigService } from '../application-document-config.service';
import { ApplicationDocumentDomainModule } from '../application-document-domain.module';
import { DocumentQueueService } from './document-queue.service';
import { DocumentRecoveryService } from './document-recovery.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>) => {
        new ApplicationDocumentConfigService(
          new ConfigService(env),
        ).validateWorker();
        return env;
      },
    }),
    ApplicationDocumentDomainModule,
  ],
  providers: [DocumentQueueService, DocumentRecoveryService],
})
export class DocumentWorkerModule {}
