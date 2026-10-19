import { Test } from '@nestjs/testing';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import type { OutboxPublisher } from './outbox-publisher';
import { OutboxConfigService } from './outbox-config.service';
import { OutboxRepository } from './outbox-repository';
import { OUTBOX_PUBLISHER } from './outbox-publisher';

describe('OutboxDispatcherService', () => {
  const config = {
    dispatchEnabled: true,
    pollIntervalMs: 1000,
    batchSize: 10,
    leaseMs: 30_000,
    maxAttempts: 3,
  } as OutboxConfigService;

  it('marks dispatched only after publish succeeds', async () => {
    const publisher: OutboxPublisher = {
      publish: jest.fn().mockResolvedValue(undefined),
    };
    const repository = {
      claimBatch: jest.fn().mockResolvedValue([
        {
          id: 'event',
          type: 'conversation.message.created',
          schemaVersion: 1,
          applicationId: 'app',
          conversationId: 'conv',
          payload: { messageId: 'm', messageSequence: 1 },
          occurredAt: new Date(),
          attemptCount: 1,
          claimToken: 'claim',
        },
      ]),
      markDispatched: jest.fn().mockResolvedValue(1),
      releaseAfterFailure: jest.fn(),
    } as unknown as OutboxRepository;

    const dispatcher = new OutboxDispatcherService(
      config,
      repository,
      publisher,
    );
    await dispatcher.dispatchOnce();

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(repository.markDispatched).toHaveBeenCalledWith(
      'event',
      'claim',
      expect.any(Date),
    );
    expect(repository.releaseAfterFailure).not.toHaveBeenCalled();
  });

  it('releases the claim when publish fails', async () => {
    const publisher: OutboxPublisher = {
      publish: jest.fn().mockRejectedValue(new Error('network')),
    };
    const repository = {
      claimBatch: jest.fn().mockResolvedValue([
        {
          id: 'event',
          type: 'conversation.message.created',
          schemaVersion: 1,
          applicationId: 'app',
          conversationId: 'conv',
          payload: {},
          occurredAt: new Date(),
          attemptCount: 1,
          claimToken: 'claim',
        },
      ]),
      markDispatched: jest.fn(),
      releaseAfterFailure: jest.fn().mockResolvedValue(1),
    } as unknown as OutboxRepository;

    const dispatcher = new OutboxDispatcherService(
      config,
      repository,
      publisher,
    );
    await dispatcher.dispatchOnce();

    expect(repository.markDispatched).not.toHaveBeenCalled();
    expect(repository.releaseAfterFailure).toHaveBeenCalled();
  });

  it('drains an active poll and leaves later claims recoverable on shutdown', async () => {
    jest.useFakeTimers();
    let finish: () => void = () => {
      throw new Error('Publish did not start');
    };
    const publisher: OutboxPublisher = {
      publish: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const claimed = ['first', 'second'].map((id) => ({
      id,
      type: 'conversation.message.created',
      schemaVersion: 1,
      applicationId: 'application',
      conversationId: 'conversation',
      payload: {},
      occurredAt: new Date(),
      attemptCount: 1,
      claimToken: 'claim',
    }));
    const repository = {
      claimBatch: jest.fn().mockResolvedValue(claimed),
      markDispatched: jest.fn().mockResolvedValue(1),
      releaseAfterFailure: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        OutboxDispatcherService,
        { provide: OutboxConfigService, useValue: config },
        { provide: OutboxRepository, useValue: repository },
        { provide: OUTBOX_PUBLISHER, useValue: publisher },
      ],
    }).compile();
    const dispatcher = module.get(OutboxDispatcherService);
    dispatcher.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    const closing = dispatcher.onModuleDestroy();
    finish();
    await closing;
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(repository.markDispatched).toHaveBeenCalledWith(
      'first',
      'claim',
      expect.any(Date),
    );
    await module.close();
    jest.useRealTimers();
  });
});
