import { Injectable } from '@nestjs/common';
import { providerApplicationIsVisible } from '../applications/application-process.policy';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/enums';
import type { RealtimeEvent } from './realtime-event';

@Injectable()
export class ConversationEventRouter {
  constructor(private readonly prisma: PrismaService) {}

  async recipients(event: RealtimeEvent): Promise<string[]> {
    const conversation = await this.prisma.applicationConversation.findFirst({
      where: { id: event.conversationId, applicationId: event.applicationId },
      select: {
        application: {
          select: {
            applicantId: true,
            applicant: { select: { role: true } },
            status: true,
            activeAt: true,
            listing: {
              select: {
                providerId: true,
                provider: { select: { role: true } },
              },
            },
          },
        },
      },
    });
    // Deleted aggregates have no authorized recipients. Database failures propagate.
    if (!conversation) return [];
    const application = conversation.application;
    const recipients: string[] = [];
    if (application.applicant.role === Role.APPLICANT)
      recipients.push(application.applicantId);
    if (
      application.listing.provider.role === Role.PROVIDER &&
      providerApplicationIsVisible(application)
    )
      recipients.push(application.listing.providerId);
    return recipients;
  }
}
