import type { Namespace, Socket } from 'socket.io';
import type { RealtimeEvent } from './realtime-event';
import type { RealtimeIdentity } from './realtime-session.service';

type NoEvents = Record<string, never>;
type ServerEvents = { 'domain-event': (event: RealtimeEvent) => void };
type SocketData = { identity?: RealtimeIdentity };
export type RealtimeSocket = Socket<
  NoEvents,
  ServerEvents,
  NoEvents,
  SocketData
>;
export type RealtimeNamespace = Namespace<
  NoEvents,
  ServerEvents,
  NoEvents,
  SocketData
>;
export function userRoom(userId: string): string {
  return `user:${userId}`;
}
