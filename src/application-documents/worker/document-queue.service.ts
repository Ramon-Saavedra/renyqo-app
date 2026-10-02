import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { setTimeout } from 'node:timers/promises';
import { ApplicationDocumentConfigService } from '../application-document-config.service';
import { ApplicationDocumentFinalizationService } from '../application-document-finalization.service';
import { parseGuardDutyEvent } from './guardduty-event.dto';
import { DocumentRecoveryService } from './document-recovery.service';

@Injectable()
export class DocumentQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentQueueService.name);
  private readonly client: SQSClient;
  private stopping = false;
  private readonly abort = new AbortController();
  constructor(
    private readonly config: ApplicationDocumentConfigService,
    private readonly finalization: ApplicationDocumentFinalizationService,
    private readonly recovery: DocumentRecoveryService,
  ) {
    this.client = new SQSClient({
      region: config.region,
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 25000,
        throwOnRequestTimeout: true,
      },
    });
  }

  stop(): void {
    this.stopping = true;
    this.abort.abort();
  }
  onModuleDestroy(): void {
    this.stop();
  }

  async run(): Promise<void> {
    this.config.validateWorker();
    await Promise.all([this.consumeLoop(), this.recoveryLoop()]);
    this.client.destroy();
  }

  private async consumeLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.queueUrl,
            WaitTimeSeconds: 20,
            MaxNumberOfMessages: 4,
            VisibilityTimeout: 180,
          }),
          { abortSignal: this.abort.signal },
        );
        await Promise.all(
          (result.Messages ?? []).map((message) => this.consume(message)),
        );
      } catch {
        if (this.stopping) break;
        this.logger.error({ signal: 'WORKER_LOOP_FAILED' });
        await this.pause(5000);
      }
    }
  }

  private async recoveryLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.recovery.run();
      } catch {
        this.logger.error({ signal: 'RECOVERY_FAILED' });
      }
      await this.pause(60_000);
    }
  }

  private async pause(duration: number): Promise<void> {
    try {
      await setTimeout(duration, undefined, { signal: this.abort.signal });
    } catch (error) {
      if (!this.stopping) throw error;
    }
  }

  async consume(message: Message): Promise<void> {
    try {
      if (!message.Body || !message.ReceiptHandle)
        throw new Error('Incomplete queue delivery');
      const verdict = parseGuardDutyEvent(message.Body, this.config);
      await this.finalization.process(verdict);
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch {
      this.logger.error({
        signal: 'SCAN_DELIVERY_FAILED',
        messageId: message.MessageId,
      });
    }
  }
}
