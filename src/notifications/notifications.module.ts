import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OutboxModule } from '../outbox/outbox.module';
import { NotificationProducer } from './notification-producer.service';
import { NotificationService } from './notification.service';
import { NotificationRetention } from './notification-retention.service';
import { NotificationsController } from './notifications.controller';
@Module({
  imports: [PrismaModule, OutboxModule],
  controllers: [NotificationsController],
  providers: [NotificationProducer, NotificationService, NotificationRetention],
  exports: [NotificationProducer],
})
export class NotificationsModule {}
