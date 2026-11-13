import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/enums';
import type { ConversationRealtimeEvent } from './realtime-event';

@Injectable()
export class ConversationEventRouter {
  constructor(private readonly prisma: PrismaService) {}

  async recipients(event: ConversationRealtimeEvent): Promise<string[]> {
    const conversation = await this.prisma.applicationConversation.findFirst({
      where: { id: event.conversationId, applicationId: event.applicationId },
      select: {
        application: {
          select: {
            applicantId: true,
            applicant: { select: { role: true, status: true } },
            status: true,
            activeAt: true,
          },
        },
      },
    });
    // Deleted aggregates have no authorized recipients. Database failures propagate.
    if (!conversation) return [];
    const application = conversation.application;
    const recipients: string[] = [];
    if (
      application.applicant.role === Role.APPLICANT &&
      application.applicant.status === 'ACTIVE'
    )
      recipients.push(application.applicantId);
    // Provider team delivery is deliberately disabled until its assigned phase.
    return recipients;
  }
}
