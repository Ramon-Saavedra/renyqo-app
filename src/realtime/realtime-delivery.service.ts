import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConversationEventRouter } from './conversation-event-router.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeConnectionsService } from './realtime-connections.service';
import type { RealtimeEvent } from './realtime-event';

@Injectable()
export class RealtimeDeliveryService implements OnModuleInit, OnModuleDestroy {
  private ready = false;
  constructor(
    private readonly config: RealtimeConfigService,
    private readonly connections: RealtimeConnectionsService,
    private readonly router: ConversationEventRouter,
  ) {}
  onModuleInit(): void {
    if (this.config.enabled) this.ready = true;
  }
  start(): void {
    this.ready = true;
  }
  assertReady(): void {
    if (!this.ready) throw new Error('Realtime transport unavailable');
  }
  async publish(
    event: RealtimeEvent,
    recipients: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    this.assertReady();
    const connections = await this.connections.eligible(recipients);
    if (signal.aborted) throw new Error('Realtime publication cancelled');
    if (!this.ready || this.connections.isStopped())
      throw new Error('Realtime transport unavailable');
    const authorized = new Set(await this.router.recipients(event));
    if (signal.aborted) throw new Error('Realtime publication cancelled');
    for (const { socket, identity } of connections) {
      if (!authorized.has(identity.userId)) continue;
      if (socket.connected) socket.emit('domain-event', event);
    }
  }
  onModuleDestroy(): void {
    this.ready = false;
  }
}
