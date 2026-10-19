import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const REALTIME_MAX_PACKET_BYTES = 4096;

function integer(config: ConfigService, key: string, fallback: number): number {
  const value: unknown = config.get(key) ?? fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`Invalid ${key}`);
  return parsed;
}

@Injectable()
export class RealtimeConfigService {
  readonly enabled: boolean;
  readonly origin: string;
  readonly recheckMs: number;
  readonly sessionLimit: number;
  readonly connectionLimit: number;
  readonly handshakeLimit: number;
  readonly handshakeWindowMs = 60_000;

  constructor(config: ConfigService) {
    const enabled: unknown = config.get('REALTIME_ENABLED') ?? 'false';
    if (!['true', 'false', '1', '0'].includes(String(enabled)))
      throw new Error('Invalid REALTIME_ENABLED');
    this.enabled = enabled === true || enabled === 'true' || enabled === '1';
    const frontend = config.get<string>('FRONTEND_URL');
    if (this.enabled && !frontend)
      throw new Error('FRONTEND_URL required for realtime');
    this.origin = new URL(frontend ?? 'http://localhost:3001').origin;
    this.recheckMs = integer(
      config,
      'REALTIME_SESSION_RECHECK_INTERVAL_MS',
      15_000,
    );
    this.sessionLimit = integer(
      config,
      'REALTIME_MAX_CONNECTIONS_PER_SESSION',
      5,
    );
    this.connectionLimit = integer(config, 'REALTIME_MAX_CONNECTIONS', 1000);
    this.handshakeLimit = integer(
      config,
      'REALTIME_HANDSHAKES_PER_IP_PER_MINUTE',
      60,
    );
  }
}
