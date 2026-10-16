import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import { providerApplicationIsVisible } from '../applications/application-process.policy';
export const conversationApplicationSelect = {
  id: true,
  listingId: true,
  applicantId: true,
  status: true,
  activeAt: true,
  listing: { select: { providerId: true, status: true } },
  conversation: {
    select: { id: true, openedAt: true, applicantRepliesEnabled: true },
  },
} satisfies Prisma.ApplicationSelect;

export type ConversationApplication = Prisma.ApplicationGetPayload<{
  select: typeof conversationApplicationSelect;
}>;

@Injectable()
export class ApplicationConversationAccessService {
  async authorize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ConversationSide,
  ): Promise<ConversationApplication> {
    const application = await tx.application.findUnique({
      where: { id: applicationId },
      select: conversationApplicationSelect,
    });
    const authorized =
      application &&
      (side === ConversationSide.PROVIDER
        ? application.listing.providerId === userId &&
          providerApplicationIsVisible(application)
        : application.applicantId === userId);
    if (!authorized || !application) {
      throw new NotFoundException('Application not found');
    }
    return application;
  }

  async lockAndAuthorize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    side: ConversationSide,
  ): Promise<ConversationApplication> {
    const reference = await this.authorize(tx, applicationId, userId, side);
    await tx.$queryRaw`SELECT id FROM "listings" WHERE id = ${reference.listingId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "applications" WHERE id = ${applicationId}::uuid FOR UPDATE`;
    return this.authorize(tx, applicationId, userId, side);
  }
}
