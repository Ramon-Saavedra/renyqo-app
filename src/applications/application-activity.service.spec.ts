import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ApplicationActivity, Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationActivityService } from './application-activity.service';

const APPLICATION_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';

const makeActivity = (
  overrides: Partial<ApplicationActivity> = {},
): ApplicationActivity => ({
  id: '00000000-0000-4000-8000-000000000003',
  applicationId: APPLICATION_ID,
  type: ApplicationActivityType.APPLICATION_SUBMITTED,
  actorUserId: ACTOR_ID,
  actorType: ApplicationActivityActorType.APPLICANT,
  visibility: ApplicationActivityVisibility.BOTH,
  occurredAt: new Date('2026-09-28T12:00:00.000Z'),
  payload: null,
  ...overrides,
});

describe('ApplicationActivityService', () => {
  let service: ApplicationActivityService;
  let prismaMock: {
    application: {
      findUnique: jest.MockedFunction<
        (args?: unknown) => Promise<{
          applicantId: string;
          status: ApplicationStatus;
          activeAt: Date | null;
          listing: { providerId: string };
        } | null>
      >;
    };
    applicationActivity: {
      create: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicationActivity>
      >;
      findMany: jest.MockedFunction<
        (args?: unknown) => Promise<ApplicationActivity[]>
      >;
      createMany: jest.MockedFunction<
        (args?: unknown) => Promise<Prisma.BatchPayload>
      >;
    };
  };

  beforeEach(() => {
    prismaMock = {
      application: {
        findUnique: jest.fn(),
      },
      applicationActivity: {
        create: jest.fn<(args?: unknown) => Promise<ApplicationActivity>>(),
        findMany: jest.fn<(args?: unknown) => Promise<ApplicationActivity[]>>(),
        createMany: jest.fn<(args?: unknown) => Promise<Prisma.BatchPayload>>(),
      },
    };
    service = new ApplicationActivityService(
      prismaMock as unknown as PrismaService,
    );
  });

  it('appends a submitted activity with safe lifecycle metadata', async () => {
    const activity = makeActivity();
    prismaMock.applicationActivity.create.mockResolvedValue(activity);

    await expect(
      service.append({
        applicationId: APPLICATION_ID,
        type: ApplicationActivityType.APPLICATION_SUBMITTED,
        actorUserId: ACTOR_ID,
        actorType: ApplicationActivityActorType.APPLICANT,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: activity.occurredAt,
        metadata: { initialStatus: ApplicationStatus.ACTIVE },
      }),
    ).resolves.toBe(activity);

    expect(prismaMock.applicationActivity.create).toHaveBeenCalledWith({
      data: {
        applicationId: APPLICATION_ID,
        type: ApplicationActivityType.APPLICATION_SUBMITTED,
        actorUserId: ACTOR_ID,
        actorType: ApplicationActivityActorType.APPLICANT,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: activity.occurredAt,
        payload: { initialStatus: ApplicationStatus.ACTIVE },
      },
    });
  });

  it('uses the supplied transaction client for transactional appends', async () => {
    const tx = {
      applicationActivity: {
        create: jest.fn<(args?: unknown) => Promise<ApplicationActivity>>(),
      },
    };
    const activity = makeActivity({
      type: ApplicationActivityType.APPLICATION_PROMOTED_TO_ACTIVE,
      actorUserId: null,
      actorType: ApplicationActivityActorType.SYSTEM,
    });
    tx.applicationActivity.create.mockResolvedValue(activity);

    await service.appendWithinTransaction(tx as never, {
      applicationId: APPLICATION_ID,
      type: ApplicationActivityType.APPLICATION_PROMOTED_TO_ACTIVE,
      actorType: ApplicationActivityActorType.SYSTEM,
      visibility: ApplicationActivityVisibility.BOTH,
      metadata: {
        fromStatus: ApplicationStatus.WAITING,
        toStatus: ApplicationStatus.ACTIVE,
      },
    });

    expect(tx.applicationActivity.create).toHaveBeenCalledWith({
      data: {
        applicationId: APPLICATION_ID,
        type: ApplicationActivityType.APPLICATION_PROMOTED_TO_ACTIVE,
        actorUserId: undefined,
        actorType: ApplicationActivityActorType.SYSTEM,
        visibility: ApplicationActivityVisibility.BOTH,
        occurredAt: undefined,
        payload: {
          fromStatus: ApplicationStatus.WAITING,
          toStatus: ApplicationStatus.ACTIVE,
        },
      },
    });
  });

  it('filters by audience, orders deterministically, and strips internal fields', async () => {
    const activities = [
      makeActivity({
        visibility: ApplicationActivityVisibility.PROVIDER,
        payload: {
          fromStatus: ApplicationStatus.ACTIVE,
          reason: ApplicationRejectionReason.NOT_SELECTED,
        },
      }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000004',
        visibility: ApplicationActivityVisibility.BOTH,
      }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000005',
        visibility: ApplicationActivityVisibility.INTERNAL,
      }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000006',
        visibility: ApplicationActivityVisibility.APPLICANT,
      }),
    ];
    prismaMock.applicationActivity.findMany.mockResolvedValue(activities);
    prismaMock.application.findUnique.mockResolvedValue({
      applicantId: 'applicant-id',
      status: ApplicationStatus.ACTIVE,
      activeAt: new Date('2026-09-28T11:00:00.000Z'),
      listing: { providerId: 'provider-id' },
    });

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'provider-id',
      ),
    ).resolves.toEqual([
      {
        id: activities[0].id,
        applicationId: activities[0].applicationId,
        type: activities[0].type,
        actorType: activities[0].actorType,
        visibility: activities[0].visibility,
        occurredAt: activities[0].occurredAt,
        payload: { fromStatus: ApplicationStatus.ACTIVE },
      },
      {
        id: activities[1].id,
        applicationId: activities[1].applicationId,
        type: activities[1].type,
        actorType: activities[1].actorType,
        visibility: activities[1].visibility,
        occurredAt: activities[1].occurredAt,
        payload: null,
      },
    ]);

    expect(prismaMock.applicationActivity.findMany).toHaveBeenCalledWith({
      where: {
        applicationId: APPLICATION_ID,
        visibility: {
          in: [
            ApplicationActivityVisibility.PROVIDER,
            ApplicationActivityVisibility.BOTH,
          ],
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    prismaMock.applicationActivity.findMany.mockResolvedValue([
      makeActivity({ visibility: ApplicationActivityVisibility.APPLICANT }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000004',
        visibility: ApplicationActivityVisibility.BOTH,
      }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000005',
        visibility: ApplicationActivityVisibility.PROVIDER,
      }),
      makeActivity({
        id: '00000000-0000-4000-8000-000000000006',
        visibility: ApplicationActivityVisibility.INTERNAL,
      }),
    ]);
    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.APPLICANT,
        'applicant-id',
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        visibility: ApplicationActivityVisibility.APPLICANT,
      }),
      expect.objectContaining({
        visibility: ApplicationActivityVisibility.BOTH,
      }),
    ]);
    expect(prismaMock.applicationActivity.findMany).toHaveBeenLastCalledWith({
      where: {
        applicationId: APPLICATION_ID,
        visibility: {
          in: [
            ApplicationActivityVisibility.APPLICANT,
            ApplicationActivityVisibility.BOTH,
          ],
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('rejects missing and unauthorized audience reads', async () => {
    prismaMock.application.findUnique.mockResolvedValue(null);

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'provider-id',
      ),
    ).rejects.toThrow('Application not found');

    prismaMock.application.findUnique.mockResolvedValue({
      applicantId: 'applicant-id',
      status: ApplicationStatus.ACTIVE,
      activeAt: new Date('2026-09-28T11:00:00.000Z'),
      listing: { providerId: 'provider-id' },
    });

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'other-provider-id',
      ),
    ).rejects.toThrow('Application not found');
    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.APPLICANT,
        'other-applicant-id',
      ),
    ).rejects.toThrow('Application not found');

    prismaMock.application.findUnique.mockResolvedValue({
      applicantId: 'applicant-id',
      status: ApplicationStatus.WAITING,
      activeAt: null,
      listing: { providerId: 'provider-id' },
    });

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'provider-id',
      ),
    ).rejects.toThrow('Application not found');
  });

  it('allows provider reads for applications that were previously active', async () => {
    prismaMock.application.findUnique.mockResolvedValue({
      applicantId: 'applicant-id',
      status: ApplicationStatus.WITHDRAWN,
      activeAt: new Date('2026-09-28T11:00:00.000Z'),
      listing: { providerId: 'provider-id' },
    });
    prismaMock.applicationActivity.findMany.mockResolvedValue([]);

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'provider-id',
      ),
    ).resolves.toEqual([]);
  });

  it.each([ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN])(
    'denies provider reads for never-active %s applications',
    async (status) => {
      prismaMock.application.findUnique.mockResolvedValue({
        applicantId: 'applicant-id',
        status,
        activeAt: null,
        listing: { providerId: 'provider-id' },
      });

      await expect(
        service.findForAudience(
          APPLICATION_ID,
          ApplicationActivityVisibility.PROVIDER,
          'provider-id',
        ),
      ).rejects.toThrow('Application not found');
    },
  );

  it('allows provider reads for previously active rejected applications', async () => {
    prismaMock.application.findUnique.mockResolvedValue({
      applicantId: 'applicant-id',
      status: ApplicationStatus.REJECTED,
      activeAt: new Date('2026-09-28T11:00:00.000Z'),
      listing: { providerId: 'provider-id' },
    });
    prismaMock.applicationActivity.findMany.mockResolvedValue([]);

    await expect(
      service.findForAudience(
        APPLICATION_ID,
        ApplicationActivityVisibility.PROVIDER,
        'provider-id',
      ),
    ).resolves.toEqual([]);
  });

  it('bulk appends activity rows in one transaction call', async () => {
    const tx = {
      applicationActivity: {
        createMany: jest.fn<(args?: unknown) => Promise<Prisma.BatchPayload>>(),
      },
    };
    tx.applicationActivity.createMany.mockResolvedValue({ count: 2 });

    await expect(
      service.appendManyWithinTransaction(tx as never, [
        {
          applicationId: APPLICATION_ID,
          type: ApplicationActivityType.APPLICATION_REJECTED,
          actorUserId: ACTOR_ID,
          actorType: ApplicationActivityActorType.PROVIDER,
          visibility: ApplicationActivityVisibility.BOTH,
          metadata: {
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.REJECTED,
          },
        },
        {
          applicationId: '00000000-0000-4000-8000-000000000004',
          type: ApplicationActivityType.APPLICATION_REJECTED,
          actorUserId: ACTOR_ID,
          actorType: ApplicationActivityActorType.PROVIDER,
          visibility: ApplicationActivityVisibility.APPLICANT,
          metadata: {
            fromStatus: ApplicationStatus.WAITING,
            toStatus: ApplicationStatus.REJECTED,
          },
        },
      ]),
    ).resolves.toEqual({ count: 2 });

    expect(tx.applicationActivity.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          applicationId: APPLICATION_ID,
          visibility: ApplicationActivityVisibility.BOTH,
        }),
        expect.objectContaining({
          applicationId: '00000000-0000-4000-8000-000000000004',
          visibility: ApplicationActivityVisibility.APPLICANT,
        }),
      ],
    });
  });

  it('keeps rejection reason as internal metadata rather than a public DTO', async () => {
    prismaMock.applicationActivity.create.mockResolvedValue(
      makeActivity({ type: ApplicationActivityType.APPLICATION_REJECTED }),
    );

    await service.append({
      applicationId: APPLICATION_ID,
      type: ApplicationActivityType.APPLICATION_REJECTED,
      actorType: ApplicationActivityActorType.SYSTEM,
      visibility: ApplicationActivityVisibility.APPLICANT,
      metadata: {
        fromStatus: ApplicationStatus.ACTIVE,
        toStatus: ApplicationStatus.REJECTED,
        reason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
      },
    });

    expect(prismaMock.applicationActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          visibility: ApplicationActivityVisibility.APPLICANT,
          payload: {
            fromStatus: ApplicationStatus.ACTIVE,
            toStatus: ApplicationStatus.REJECTED,
            reason: ApplicationRejectionReason.PROFILE_NO_LONGER_ELIGIBLE,
          },
        }),
      }),
    );
  });
});
