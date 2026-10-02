import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApplicationDocumentConfigService } from '../application-document-config.service';
import { DocumentWorkerModule } from './document-worker.module';
import { DocumentQueueService } from './document-queue.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(DocumentWorkerModule);
  const queue = app.get(DocumentQueueService);
  const stop = () => queue.stop();
  try {
    app.get(ApplicationDocumentConfigService).validateWorker();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await queue.run();
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await app.close();
  }
}

void bootstrap().catch(() => {
  new Logger('DocumentWorker').error('Document worker could not start');
  process.exitCode = 1;
});
