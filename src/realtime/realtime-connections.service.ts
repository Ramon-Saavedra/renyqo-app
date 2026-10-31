import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RealtimeConfigService } from './realtime-config.service';
import {
  RealtimeSessionService,
  type RealtimeIdentity,
} from './realtime-session.service';
import { type RealtimeSocket, userRoom } from './realtime-socket';

type Connection = { socket: RealtimeSocket; identity: RealtimeIdentity };

@Injectable()
export class RealtimeConnectionsService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeConnectionsService.name);
  private readonly connections = new Map<string, Connection>();
  private timer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly config: RealtimeConfigService,
    private readonly sessions: RealtimeSessionService,
  ) {}

  async add(socket: RealtimeSocket, identity: RealtimeIdentity): Promise<void> {
    const count = [...this.connections.values()].filter(
      (entry) => entry.identity.sessionId === identity.sessionId,
    ).length;
    if (
      this.stopped ||
      socket.conn.readyState !== 'open' ||
      this.connections.size >= this.config.connectionLimit ||
      count >= this.config.sessionLimit
    )
      throw new Error('Connection limit reached');
    socket.data.identity = identity;
    this.connections.set(socket.id, { socket, identity });
    socket.once('disconnect', () => this.connections.delete(socket.id));
    socket.onAny(() => socket.disconnect(true));
    try {
      await socket.join(userRoom(identity.userId));
      if (socket.conn.readyState !== 'open')
        throw new Error('Connection closed during authentication');
    } catch (error) {
      this.connections.delete(socket.id);
      throw error;
    }
    if (!this.timer && !this.checking) this.schedule();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  disconnectSessions(sessionIds: readonly string[]): void {
    const targets = new Set(sessionIds);
    for (const entry of this.connections.values()) {
      if (targets.has(entry.identity.sessionId)) {
        try {
          entry.socket.disconnect(true);
        } catch {
          this.logger.warn({ signal: 'REALTIME_DISCONNECT_FAILED' });
        }
      }
    }
  }

  disconnectUser(userId: string): void {
    for (const entry of this.connections.values()) {
      if (entry.identity.userId === userId) entry.socket.disconnect(true);
    }
  }

  async eligible(userIds: readonly string[]): Promise<Connection[]> {
    const users = new Set(userIds);
    const candidates = [...this.connections.values()].filter(
      (entry) => users.has(entry.identity.userId) && entry.socket.connected,
    );
    const valid = await this.sessions.valid(
      candidates.map((entry) => entry.identity.sessionId),
    );
    return candidates.filter((entry) => {
      const identity = valid.get(entry.identity.sessionId);
      const allowed =
        identity?.userId === entry.identity.userId &&
        identity.role === entry.identity.role;
      if (!allowed) {
        try {
          entry.socket.disconnect(true);
        } catch {
          this.logger.warn({ signal: 'REALTIME_DISCONNECT_FAILED' });
        }
      }
      return allowed && entry.socket.connected && !this.stopped;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.checking = this.revalidate().finally(() => {
        this.checking = undefined;
        this.schedule();
      });
    }, this.config.recheckMs);
    this.timer.unref();
  }

  private async revalidate(): Promise<void> {
    try {
      await this.eligible([
        ...new Set(
          [...this.connections.values()].map((entry) => entry.identity.userId),
        ),
      ]);
    } catch {
      this.logger.warn({ signal: 'REALTIME_SESSION_VALIDATION_UNAVAILABLE' });
      this.disconnectSessions(
        [...this.connections.values()].map(
          ({ identity }) => identity.sessionId,
        ),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const { socket } of this.connections.values()) socket.disconnect(true);
    this.connections.clear();
    await this.checking;
  }
}
