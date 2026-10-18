import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeEnv } from '../config/env.validation';

@Injectable()
export class OutboxConfigService implements OnModuleInit {
  readonly dispatchEnabled: boolean;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retentionDays: number;
  readonly retentionBatchSize: number;

  constructor(config: ConfigService) {
    this.dispatchEnabled = parseBoolean(
      config.get<string>('OUTBOX_DISPATCH_ENABLED'),
      false,
    );
    this.pollIntervalMs = parsePositiveInt(
      config.get<string>('OUTBOX_POLL_INTERVAL_MS'),
      1000,
    );
    this.batchSize = parsePositiveInt(
      config.get<string>('OUTBOX_BATCH_SIZE'),
      50,
    );
    this.leaseMs = parsePositiveInt(
      config.get<string>('OUTBOX_LEASE_MS'),
      30_000,
    );
    this.maxAttempts = parsePositiveInt(
      config.get<string>('OUTBOX_MAX_ATTEMPTS'),
      25,
    );
    this.retentionDays = parsePositiveInt(
      config.get<string>('OUTBOX_RETENTION_DAYS'),
      7,
    );
    this.retentionBatchSize = parsePositiveInt(
      config.get<string>('OUTBOX_RETENTION_BATCH_SIZE'),
      500,
    );
  }

  onModuleInit(): void {
    const nodeEnv = process.env['NODE_ENV'];
    if (this.dispatchEnabled && nodeEnv === NodeEnv.Production) {
      throw new Error(
        'OUTBOX_DISPATCH_ENABLED cannot be true in production until a realtime transport publisher is configured. Events are still written to the outbox; HTTP remains authoritative.',
      );
    }
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer environment value: ${value}`);
  }
  return parsed;
}
