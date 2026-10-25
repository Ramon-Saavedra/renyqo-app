import { ApplicationOutboxProducer } from './application-outbox.producer';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConversationOutboxProducer } from './conversation-outbox.producer';
import { RealtimeModule } from '../realtime/realtime.module';
import { RealtimeOutboxPublisher } from '../realtime/realtime-outbox.publisher';
import { OutboxConfigService } from './outbox-config.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OUTBOX_PUBLISHER } from './outbox-publisher';
import { OutboxRepository } from './outbox-repository';
import { OutboxRetentionService } from './outbox-retention.service';
import { OutboxWriter } from './outbox-writer.service';

@Module({
  imports: [PrismaModule, RealtimeModule],
  providers: [
    OutboxConfigService,
    OutboxWriter,
    ApplicationOutboxProducer,
    ConversationOutboxProducer,
    OutboxRepository,
    OutboxDispatcherService,
    OutboxRetentionService,
    { provide: OUTBOX_PUBLISHER, useExisting: RealtimeOutboxPublisher },
  ],
  exports: [
    ApplicationOutboxProducer,
    OutboxWriter,
    ConversationOutboxProducer,
  ],
})
export class OutboxModule {}
