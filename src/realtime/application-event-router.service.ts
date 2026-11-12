import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma/enums';
import {
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
        applicant: { select: { role: true, status: true } },
        listingId: true,
      },
    });
    if (!app || app.listingId !== event.payload.listingId) return [];
    const routes: { userId: string; event: RealtimeEvent }[] = [];
    if (
      app.applicant.role === Role.APPLICANT &&
      app.applicant.status === 'ACTIVE'
    )
      routes.push({ userId: app.applicantId, event });
    // Provider team delivery remains disabled; no creator/responsible fallback.
    return routes;
  }
}
