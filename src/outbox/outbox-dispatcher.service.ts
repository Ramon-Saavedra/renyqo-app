import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OutboxConfigService } from './outbox-config.service';
import { OutboxRepository } from './outbox-repository';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from './outbox-publisher';

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private pollInFlight = false;
  private stopped = false;

  constructor(
    private readonly config: OutboxConfigService,
    private readonly repository: OutboxRepository,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
  ) {}

  onModuleInit(): void {
    if (!this.config.dispatchEnabled) {
      this.logger.log({
        signal: 'OUTBOX_DISPATCH_DISABLED',
        message:
          'Outbox rows are persisted with domain mutations; realtime delivery is inactive until OUTBOX_DISPATCH_ENABLED is true with a transport publisher.',
      });
      return;
    }
    this.stopped = false;
    this.schedulePoll(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) {
      this.schedulePoll(this.config.pollIntervalMs);
      return;
    }
    this.pollInFlight = true;
    try {
      await this.dispatchOnce();
    } catch (error) {
      this.logger.error({
        signal: 'OUTBOX_DISPATCH_POLL_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
      this.schedulePoll(this.config.pollIntervalMs);
    }
  }

  async dispatchOnce(): Promise<void> {
    const asOf = new Date();
    const claimToken = randomUUID();
    const leaseUntil = new Date(asOf.getTime() + this.config.leaseMs);
    const claimed = await this.repository.claimBatch(
      claimToken,
      asOf,
      leaseUntil,
      this.config.batchSize,
    );
    for (const event of claimed) {
      // Remaining claims expire naturally if shutdown or a slow batch exhausts the lease.
      if (this.stopped || Date.now() >= leaseUntil.getTime()) break;
      try {
        await this.publisher.publish({
          eventId: event.id,
          type: event.type,
          schemaVersion: event.schemaVersion,
          applicationId: event.applicationId,
          userId: event.userId,
          conversationId: event.conversationId,
          occurredAt: event.occurredAt,
          payload: event.payload,
        });
        const marked = await this.repository.markDispatched(
          event.id,
          event.claimToken,
          new Date(),
        );
        if (marked !== 1) {
          this.logger.warn({
            signal: 'OUTBOX_DISPATCH_MARK_MISMATCH',
            eventId: event.id,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Outbox publish failed';
        const exhausted = event.attemptCount >= this.config.maxAttempts;
        const backoffMs = Math.min(
          60_000,
          1000 * 2 ** Math.min(event.attemptCount, 6),
        );
        await this.repository.releaseAfterFailure(
          event.id,
          event.claimToken,
          new Date(Date.now() + backoffMs),
          message,
          exhausted,
        );
        this.logger.error({
          signal: exhausted
            ? 'OUTBOX_DISPATCH_EXHAUSTED'
            : 'OUTBOX_DISPATCH_PUBLISH_FAILED',
          eventId: event.id,
          attemptCount: event.attemptCount,
          error: message,
        });
      }
    }
  }
}
