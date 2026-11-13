import { unitActor } from '../../test/unit-workspace-authority';
import { ApplicationListingAccess } from '../listings/application-listing-access';
import { ApplicationConversationAccessService } from './application-conversation-access.service';
import { Test } from '@nestjs/testing';
import { ApplicationActivityService } from '../applications/application-activity.service';
import {
  ApplicationStatus,
  ConversationSide,
  ListingStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationConversationService } from './application-conversation.service';
import { ConversationOutboxProducer } from '../outbox/conversation-outbox.producer';
import { ApplicationMessageService } from './application-message.service';

describe('ApplicationConversationService workflow state', () => {
  const application = {
    id: 'application',
    listingId: 'listing',
    applicantId: 'applicant',
    status: ApplicationStatus.ACTIVE,
    activeAt: new Date(),
    listing: {
      workspaceId: '00000000-0000-4000-8000-000000000090',
      responsibleMembershipId: '00000000-0000-4000-8000-000000000091',
      status: ListingStatus.PUBLISHED,
    },
    conversation: {
      id: 'conversation',
      openedAt: new Date(),
      applicantRepliesEnabled: true,
    },
  };
  const lastMessage = {
    id: 'message',
    conversationId: 'conversation',
    sequence: 1,
    senderType: ConversationSide.PROVIDER,
    body: 'Hello',
    createdAt: new Date(),
    readAt: null,
  };
  const tx = {
    application: { findUnique: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ allowed: true }]),
  };
  const messages = {
    snapshot: jest.fn(),
    toDto: new ApplicationMessageService().toDto,
  };
  let service: ApplicationConversationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tx.application.findUnique.mockResolvedValue(application);
    messages.snapshot.mockResolvedValue({ lastMessage, unreadCount: 1 });
    const module = await Test.createTestingModule({
      providers: [
        ApplicationConversationService,
        ApplicationConversationAccessService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: <T>(operation: (client: typeof tx) => Promise<T>) =>
              operation(tx),
          },
        },
        {
          provide: ApplicationListingAccess,
          useValue: {
            read: async (
              _actor: unknown,
              _side: unknown,
              _applicationId: string,
              policy: (client: typeof tx) => Promise<unknown>,
              produce: (client: typeof tx) => Promise<unknown>,
            ) => {
              await policy(tx);
              return produce(tx);
            },
            mutate: async (
              _actor: unknown,
              _side: unknown,
              _applicationId: string,
              policy: (client: typeof tx) => Promise<unknown>,
              produce: (
                client: typeof tx,
                listingId: string,
              ) => Promise<unknown>,
            ) => {
              await policy(tx);
              return produce(tx, 'listing');
            },
          },
        },
        { provide: ApplicationMessageService, useValue: messages },
        { provide: ApplicationActivityService, useValue: {} },
        {
          provide: ConversationOutboxProducer,
          useValue: {
            messageCreated: jest.fn(),
            readAdvanced: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(ApplicationConversationService);
  });

  it('allows both participants independently of the last sender when replies are enabled', async () => {
    for (const sender of [
      ConversationSide.PROVIDER,
      ConversationSide.APPLICANT,
    ]) {
      messages.snapshot.mockResolvedValue({
        lastMessage: { ...lastMessage, senderType: sender },
        unreadCount: 1,
      });
      for (const side of [
        ConversationSide.PROVIDER,
        ConversationSide.APPLICANT,
      ]) {
        await expect(
          service.summary(
            'application',
            unitActor(
              side === ConversationSide.PROVIDER ? 'provider' : 'applicant',
              side,
            ),
            side,
          ),
        ).resolves.toMatchObject({
          hasMessages: true,
          applicantRepliesEnabled: true,
          canCurrentUserSend: true,
          sendBlockReason: null,
        });
      }
    }
  });
  it('blocks applicant replies by default without blocking the provider', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      conversation: null,
    });
    await expect(
      service.summary(
        'application',
        unitActor('provider', ConversationSide.PROVIDER),
        ConversationSide.PROVIDER,
      ),
    ).resolves.toMatchObject({
      hasMessages: false,
      canCurrentUserSend: true,
      applicantRepliesEnabled: false,
    });
    await expect(
      service.summary(
        'application',
        unitActor('applicant', ConversationSide.APPLICANT),
        ConversationSide.APPLICANT,
      ),
    ).resolves.toMatchObject({
      canCurrentUserSend: false,
      sendBlockReason: 'APPLICANT_REPLIES_DISABLED',
    });
  });
  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])('retains readable history and disables sending in %s', async (status) => {
    tx.application.findUnique.mockResolvedValue({ ...application, status });
    await expect(
      service.summary(
        'application',
        unitActor('provider', ConversationSide.PROVIDER),
        ConversationSide.PROVIDER,
      ),
    ).resolves.toMatchObject({
      hasMessages: true,
      canCurrentUserSend: false,
      sendBlockReason: 'LIFECYCLE_READ_ONLY',
    });
  });

  it('disables sending on a rented listing', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      listing: { ...application.listing, status: ListingStatus.RENTED },
    });
    await expect(
      service.summary(
        'application',
        unitActor('applicant', ConversationSide.APPLICANT),
        ConversationSide.APPLICANT,
      ),
    ).resolves.toHaveProperty('canCurrentUserSend', false);
  });

  it('denies all provider access while WAITING even if previously active', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      status: ApplicationStatus.WAITING,
    });
    await expect(
      service.summary(
        'application',
        unitActor('provider', ConversationSide.PROVIDER),
        ConversationSide.PROVIDER,
      ),
    ).rejects.toThrow('Application not found');
    expect(messages.snapshot).not.toHaveBeenCalled();
  });

  it('hides never-visible rejected applications', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      status: ApplicationStatus.REJECTED,
      activeAt: null,
    });
    await expect(
      service.summary(
        'application',
        unitActor('provider', ConversationSide.PROVIDER),
        ConversationSide.PROVIDER,
      ),
    ).rejects.toThrow('Application not found');
  });

  it.each([
    ['outsider', ConversationSide.PROVIDER],
    ['outsider', ConversationSide.APPLICANT],
  ])('denies ownership mismatch for %s/%s', async (userId, side) => {
    if (side === ConversationSide.PROVIDER) {
      tx.$queryRaw.mockResolvedValueOnce([{ allowed: false }]);
    }
    await expect(
      service.summary('application', unitActor(userId, side), side),
    ).rejects.toThrow('Application not found');
    expect(messages.snapshot).not.toHaveBeenCalled();
  });
});
