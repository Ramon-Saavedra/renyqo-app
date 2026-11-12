import { randomUUID } from 'node:crypto';
import { ApplicationEventRouter } from './application-event-router.service';
import { type ApplicationRealtimeEvent } from './realtime-event';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationStatus, Role } from '../generated/prisma/enums';

describe('Application event authorization', () => {
  const listingId = randomUUID(),
    applicantId = randomUUID();
  const event: ApplicationRealtimeEvent = {
    type: 'application.lifecycle.changed',
    eventId: randomUUID(),
    applicationId: randomUUID(),
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    payload: { listingId },
  };
  const base = {
    applicantId,
    applicant: { role: Role.APPLICANT, status: 'ACTIVE' },
    listingId,
    status: ApplicationStatus.ACTIVE,
    activeAt: new Date(),
  };
  it.each([
    ApplicationStatus.ACTIVE,
    ApplicationStatus.REJECTED,
    ApplicationStatus.WITHDRAWN,
    ApplicationStatus.ACCEPTED,
  ])(
    'routes full invalidation under current historical %s visibility',
    async (status) => {
      const findUnique = jest.fn().mockResolvedValue({ ...base, status });
      const router = new ApplicationEventRouter({
        application: { findUnique },
      } as unknown as PrismaService);
      expect(await router.routes(event)).toEqual([
        { userId: applicantId, event },
      ]);
    },
  );
  it.each([ApplicationStatus.WAITING, ApplicationStatus.REJECTED])(
    'keeps applicant delivery and disables provider hints for hidden %s applications',
    async (status) => {
      const findUnique = jest
        .fn()
        .mockResolvedValue({ ...base, status, activeAt: null });
      const router = new ApplicationEventRouter({
        application: { findUnique },
      } as unknown as PrismaService);
      const routes = await router.routes(event);
      expect(routes[0]).toEqual({ userId: applicantId, event });
      expect(routes).toHaveLength(1);
    },
  );
  it('drops deleted applications, mismatched listings and changed roles', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const router = new ApplicationEventRouter({
      application: { findUnique },
    } as unknown as PrismaService);
    expect(await router.routes(event)).toEqual([]);
    findUnique.mockResolvedValue({
      ...base,
      applicant: { role: Role.APPLICANT, status: 'DISABLED' },
    });
    expect(await router.routes(event)).toEqual([]);
    findUnique.mockResolvedValue({ ...base, listingId: randomUUID() });
    expect(await router.routes(event)).toEqual([]);
    findUnique.mockResolvedValue({
      ...base,
      applicant: { role: Role.PROVIDER, status: 'ACTIVE' },
    });
    expect(await router.routes(event)).toEqual([]);
  });
});
