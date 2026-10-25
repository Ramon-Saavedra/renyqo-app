import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/enums';
import { providerApplicationIsVisible } from '../applications/application-process.policy';
import {
  listingInvalidation,
  type ApplicationRealtimeEvent,
  type RealtimeEvent,
} from './realtime-event';

@Injectable()
export class ApplicationEventRouter {
  constructor(private readonly prisma: PrismaService) {}
  async routes(
    event: ApplicationRealtimeEvent,
  ): Promise<{ userId: string; event: RealtimeEvent }[]> {
    const app = await this.prisma.application.findUnique({
      where: { id: event.applicationId },
      select: {
        applicantId: true,
        status: true,
        activeAt: true,
        applicant: { select: { role: true } },
        listingId: true,
        listing: {
          select: { providerId: true, provider: { select: { role: true } } },
        },
      },
    });
    if (!app || app.listingId !== event.payload.listingId) return [];
    const routes: { userId: string; event: RealtimeEvent }[] = [];
    if (app.applicant.role === Role.APPLICANT)
      routes.push({ userId: app.applicantId, event });
    if (app.listing.provider.role === Role.PROVIDER)
      routes.push({
        userId: app.listing.providerId,
        event: providerApplicationIsVisible(app)
          ? event
          : listingInvalidation(event, app.listingId),
      });
    return routes;
  }
}
