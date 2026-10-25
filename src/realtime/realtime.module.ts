import { ApplicationEventRouter } from './application-event-router.service';
import { RealtimeEventRouter } from './realtime-event-router.service';
import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConversationEventRouter } from './conversation-event-router.service';
import { RealtimeAdmissionService } from './realtime-admission.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeConnectionsService } from './realtime-connections.service';
import { RealtimeDeliveryService } from './realtime-delivery.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeOutboxPublisher } from './realtime-outbox.publisher';
import { RealtimeSessionService } from './realtime-session.service';

@Module({
  imports: [PrismaModule, SessionModule],
  providers: [
    RealtimeConfigService,
    RealtimeSessionService,
    RealtimeConnectionsService,
    RealtimeAdmissionService,
    ConversationEventRouter,
    ApplicationEventRouter,
    RealtimeEventRouter,
    RealtimeDeliveryService,
    RealtimeGateway,
    RealtimeOutboxPublisher,
  ],
  exports: [
    RealtimeOutboxPublisher,
    RealtimeConfigService,
    RealtimeConnectionsService,
  ],
})
export class RealtimeModule {}
