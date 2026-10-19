import { WebSocketGateway, type OnGatewayInit } from '@nestjs/websockets';
import { RealtimeAdmissionService } from './realtime-admission.service';
import {
  REALTIME_MAX_PACKET_BYTES,
  RealtimeConfigService,
} from './realtime-config.service';
import { RealtimeDeliveryService } from './realtime-delivery.service';
import type { RealtimeNamespace } from './realtime-socket';

@WebSocketGateway({
  namespace: '/realtime',
  transports: ['websocket'],
  serveClient: false,
  maxHttpBufferSize: REALTIME_MAX_PACKET_BYTES,
})
export class RealtimeGateway implements OnGatewayInit<RealtimeNamespace> {
  constructor(
    private readonly admission: RealtimeAdmissionService,
    private readonly config: RealtimeConfigService,
    private readonly delivery: RealtimeDeliveryService,
  ) {}
  afterInit(namespace: RealtimeNamespace): void {
    this.admission.bind(namespace);
    if (this.config.enabled) this.delivery.start();
  }
}
