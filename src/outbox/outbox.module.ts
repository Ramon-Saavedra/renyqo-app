import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConversationOutboxProducer } from './conversation-outbox.producer';
import { LoggingOutboxPublisher } from './logging-outbox.publisher';
import { OutboxConfigService } from './outbox-config.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OUTBOX_PUBLISHER } from './outbox-publisher';
import { OutboxRepository } from './outbox-repository';
import { OutboxRetentionService } from './outbox-retention.service';
import { OutboxWriter } from './outbox-writer.service';

@Module({
  imports: [PrismaModule],
  providers: [
    OutboxConfigService,
    OutboxWriter,
    ConversationOutboxProducer,
    OutboxRepository,
    OutboxDispatcherService,
    OutboxRetentionService,
    LoggingOutboxPublisher,
    { provide: OUTBOX_PUBLISHER, useExisting: LoggingOutboxPublisher },
  ],
  exports: [OutboxWriter, ConversationOutboxProducer],
})
export class OutboxModule {}
