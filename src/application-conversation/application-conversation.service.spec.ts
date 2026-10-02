import { Test } from '@nestjs/testing';
import { ApplicationActivityService } from '../applications/application-activity.service';
import {
  ApplicationStatus,
  ConversationSide,
  ListingStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationConversationService } from './application-conversation.service';
import { ApplicationMessageService } from './application-message.service';

describe('ApplicationConversationService workflow state', () => {
  const application = {
    id: 'application',
    listingId: 'listing',
    applicantId: 'applicant',
    status: ApplicationStatus.ACTIVE,
    activeAt: new Date(),
    listing: { providerId: 'provider', status: ListingStatus.PUBLISHED },
    conversation: { id: 'conversation', openedAt: new Date() },
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
  const tx = { application: { findUnique: jest.fn() } };
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
        {
          provide: PrismaService,
          useValue: {
            $transaction: <T>(operation: (client: typeof tx) => Promise<T>) =>
              operation(tx),
          },
        },
        { provide: ApplicationMessageService, useValue: messages },
        { provide: ApplicationActivityService, useValue: {} },
      ],
    }).compile();
    service = module.get(ApplicationConversationService);
  });

  it('reports the applicant turn after a provider message', async () => {
    await expect(
      service.summary('application', 'applicant', ConversationSide.APPLICANT),
    ).resolves.toMatchObject({
      isOpen: true,
      canCurrentUserSend: true,
      expectedResponder: ConversationSide.APPLICANT,
      unreadCount: 1,
    });
    await expect(
      service.summary('application', 'provider', ConversationSide.PROVIDER),
    ).resolves.toHaveProperty('canCurrentUserSend', false);
  });

  it('reports the provider turn after an applicant message', async () => {
    messages.snapshot.mockResolvedValue({
      lastMessage: { ...lastMessage, senderType: ConversationSide.APPLICANT },
      unreadCount: 1,
    });
    await expect(
      service.summary('application', 'provider', ConversationSide.PROVIDER),
    ).resolves.toHaveProperty('canCurrentUserSend', true);
  });

  it('only allows the provider to initiate a closed conversation', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      conversation: null,
    });
    await expect(
      service.summary('application', 'provider', ConversationSide.PROVIDER),
    ).resolves.toMatchObject({
      isOpen: false,
      canCurrentUserSend: true,
      conversationId: null,
      expectedResponder: ConversationSide.PROVIDER,
    });
    await expect(
      service.summary('application', 'applicant', ConversationSide.APPLICANT),
    ).resolves.toHaveProperty('canCurrentUserSend', false);
  });

  it.each([
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])('retains readable history and disables sending in %s', async (status) => {
    tx.application.findUnique.mockResolvedValue({ ...application, status });
    await expect(
      service.summary('application', 'provider', ConversationSide.PROVIDER),
    ).resolves.toMatchObject({
      isOpen: true,
      canCurrentUserSend: false,
      expectedResponder: null,
    });
  });

  it('disables sending on a rented listing', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      listing: { ...application.listing, status: ListingStatus.RENTED },
    });
    await expect(
      service.summary('application', 'applicant', ConversationSide.APPLICANT),
    ).resolves.toHaveProperty('canCurrentUserSend', false);
  });

  it('denies all provider access while WAITING even if previously active', async () => {
    tx.application.findUnique.mockResolvedValue({
      ...application,
      status: ApplicationStatus.WAITING,
    });
    await expect(
      service.summary('application', 'provider', ConversationSide.PROVIDER),
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
      service.summary('application', 'provider', ConversationSide.PROVIDER),
    ).rejects.toThrow('Application not found');
  });

  it.each([
    ['outsider', ConversationSide.PROVIDER],
    ['outsider', ConversationSide.APPLICANT],
  ])('denies ownership mismatch for %s/%s', async (userId, side) => {
    await expect(service.summary('application', userId, side)).rejects.toThrow(
      'Application not found',
    );
    expect(messages.snapshot).not.toHaveBeenCalled();
  });
});
