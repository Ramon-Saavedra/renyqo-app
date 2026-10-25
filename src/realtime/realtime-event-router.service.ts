import { Injectable } from '@nestjs/common';
import { ConversationEventRouter } from './conversation-event-router.service';
import { ApplicationEventRouter } from './application-event-router.service';
import { isApplicationEvent, type RealtimeEvent } from './realtime-event';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RealtimeEventRouter {
  constructor(
    private readonly conversations: ConversationEventRouter,
    private readonly applications: ApplicationEventRouter,
    private readonly prisma: PrismaService,
  ) {}
  async routes(
    event: RealtimeEvent,
  ): Promise<{ userId: string; event: RealtimeEvent }[]> {
    if (isApplicationEvent(event)) return this.applications.routes(event);
    if (event.type === 'notifications.changed') {
      const user = await this.prisma.user.findFirst({
        where: {
          id: event.userId,
          status: 'ACTIVE',
          role: { in: ['PROVIDER', 'APPLICANT'] },
        },
        select: { id: true },
      });
      return user ? [{ userId: user.id, event }] : [];
    }
    if (event.type === 'listing.applications.changed')
      throw new Error(
        'Listing hints can only be derived from authorized application routing',
      );
    return (await this.conversations.recipients(event)).map((userId) => ({
      userId,
      event,
    }));
  }
  async recipients(event: RealtimeEvent) {
    return (await this.routes(event)).map((r) => r.userId);
  }
}
