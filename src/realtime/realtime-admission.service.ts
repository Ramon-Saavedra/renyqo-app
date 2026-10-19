import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { SessionInfrastructureService } from '../auth/session/session-infrastructure.service';
import { RealtimeConfigService } from './realtime-config.service';
import { RealtimeConnectionsService } from './realtime-connections.service';
import { RealtimeSessionService } from './realtime-session.service';
import type { RealtimeNamespace } from './realtime-socket';

@Injectable()
export class RealtimeAdmissionService {
  private readonly logger = new Logger(RealtimeAdmissionService.name);
  private readonly attempts = new Map<string, number>();
  private windowStarted = Date.now();

  constructor(
    private readonly config: RealtimeConfigService,
    private readonly infrastructure: SessionInfrastructureService,
    private readonly sessions: RealtimeSessionService,
    private readonly connections: RealtimeConnectionsService,
  ) {}

  bind(namespace: RealtimeNamespace): void {
    namespace.server.engine.opts.allowRequest = (request, done) => {
      done(null, this.accept(request));
    };
    namespace.server
      .of('/')
      .use((_socket, next) => next(new Error('Unsupported namespace')));
    namespace.use((socket, next) => {
      void this.sessions
        .authenticate(socket.request.headers.cookie)
        .then((identity) => this.connections.add(socket, identity))
        .then(() => next())
        .catch(() => {
          this.logger.warn({ signal: 'REALTIME_CONNECTION_REJECTED' });
          next(new Error('Realtime connection rejected'));
        });
    });
  }

  private accept(request: IncomingMessage): boolean {
    if (!this.config.enabled || request.headers.origin !== this.config.origin)
      return false;
    if (Date.now() - this.windowStarted >= this.config.handshakeWindowMs) {
      this.attempts.clear();
      this.windowStarted = Date.now();
    }
    const ip = request.socket.remoteAddress ?? 'unknown';
    if (
      !this.attempts.has(ip) &&
      this.attempts.size >= this.config.connectionLimit
    )
      return false;
    const count = (this.attempts.get(ip) ?? 0) + 1;
    this.attempts.set(ip, count);
    return (
      count <= this.config.handshakeLimit &&
      this.infrastructure.signedSessionId(request.headers.cookie) !== null
    );
  }
}
