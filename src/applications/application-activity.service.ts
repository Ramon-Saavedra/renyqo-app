import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicationActivity, Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ApplicationDocumentType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type ApplicationActivityMetadata = {
  viewingId?: string;
  viewingRound?: number;
  previousViewingId?: string;
  startsAt?: string;
  endsAt?: string;
  outcomeRevision?: number;
  requestId?: string;
  documentType?: ApplicationDocumentType;
  initialStatus?: ApplicationStatus;
  fromStatus?: ApplicationStatus;
  toStatus?: ApplicationStatus;
  reason?: ApplicationRejectionReason;
};

export type AppendApplicationActivityInput = {
  applicationId: string;
  type: ApplicationActivityType;
  actorUserId?: string;
  actorType: ApplicationActivityActorType;
  visibility: ApplicationActivityVisibility;
  occurredAt?: Date;
  metadata?: ApplicationActivityMetadata;
};

export type ApplicationActivityTimelineItem = Omit<
  ApplicationActivity,
  'actorUserId' | 'payload'
> & {
  payload: Omit<ApplicationActivityMetadata, 'reason'> | null;
};

type PublicActivityAudience =
  | typeof ApplicationActivityVisibility.PROVIDER
  | typeof ApplicationActivityVisibility.APPLICANT;

@Injectable()
export class ApplicationActivityService {
  constructor(private readonly prisma: PrismaService) {}

  append(input: AppendApplicationActivityInput): Promise<ApplicationActivity> {
    return this.create(this.prisma, input);
  }

  appendWithinTransaction(
    tx: Prisma.TransactionClient,
    input: AppendApplicationActivityInput,
  ): Promise<ApplicationActivity> {
    return this.create(tx, input);
  }

  appendManyWithinTransaction(
    tx: Prisma.TransactionClient,
    inputs: AppendApplicationActivityInput[],
  ): Promise<Prisma.BatchPayload> {
    if (inputs.length === 0) {
      return Promise.resolve({ count: 0 });
    }

    return tx.applicationActivity.createMany({
      data: inputs.map((input) => ({
        applicationId: input.applicationId,
        type: input.type,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        visibility: input.visibility,
        occurredAt: input.occurredAt,
        payload: input.metadata,
      })),
    });
  }

  findForAudience(
    applicationId: string,
    audience: PublicActivityAudience,
    userId: string,
  ): Promise<ApplicationActivityTimelineItem[]> {
    return this.prisma.application
      .findUnique({
        where: { id: applicationId },
        select: {
          applicantId: true,
          status: true,
          activeAt: true,
          listing: { select: { providerId: true } },
        },
      })
      .then((application) => {
        const ownsApplication =
          audience === ApplicationActivityVisibility.PROVIDER
            ? application?.listing.providerId === userId &&
              application.status !== ApplicationStatus.WAITING &&
              (application.status === ApplicationStatus.ACTIVE ||
                application.activeAt !== null)
            : application?.applicantId === userId;

        if (!ownsApplication) {
          throw new NotFoundException('Application not found');
        }

        return this.prisma.applicationActivity
          .findMany({
            where: {
              applicationId,
              visibility: {
                in: [audience, ApplicationActivityVisibility.BOTH],
              },
            },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          })
          .then((activities) =>
            activities
              .filter(
                (activity) =>
                  activity.visibility === audience ||
                  activity.visibility === ApplicationActivityVisibility.BOTH,
              )
              .map((activity) => this.toTimelineItem(activity)),
          );
      });
  }

  private toTimelineItem(
    activity: ApplicationActivity,
  ): ApplicationActivityTimelineItem {
    const payload = this.toPublicPayload(activity.payload);

    return {
      id: activity.id,
      applicationId: activity.applicationId,
      type: activity.type,
      actorType: activity.actorType,
      visibility: activity.visibility,
      occurredAt: activity.occurredAt,
      payload,
    };
  }

  private toPublicPayload(
    payload: Prisma.JsonValue,
  ): Omit<ApplicationActivityMetadata, 'reason'> | null {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return null;
    }

    const record = payload;
    const safePayload: Omit<ApplicationActivityMetadata, 'reason'> = {};

    for (const key of ['viewingId', 'previousViewingId'] as const) {
      if (
        typeof record[key] === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
          record[key],
        )
      )
        safePayload[key] = record[key];
    }
    for (const key of ['startsAt', 'endsAt'] as const) {
      const value = record[key];
      if (
        typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value
      )
        safePayload[key] = value;
    }
    for (const key of ['viewingRound', 'outcomeRevision'] as const) {
      const value = record[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
        safePayload[key] = value;
    }

    if (typeof record['requestId'] === 'string')
      safePayload.requestId = record['requestId'];
    if (typeof record['documentType'] === 'string') {
      const type = Object.values(ApplicationDocumentType).find(
        (value) => value === record['documentType'],
      );
      if (type) safePayload.documentType = type;
    }

    if (typeof record['initialStatus'] === 'string') {
      safePayload.initialStatus = record['initialStatus'] as ApplicationStatus;
    }
    if (typeof record['fromStatus'] === 'string') {
      safePayload.fromStatus = record['fromStatus'] as ApplicationStatus;
    }
    if (typeof record['toStatus'] === 'string') {
      safePayload.toStatus = record['toStatus'] as ApplicationStatus;
    }

    return safePayload;
  }

  private create(
    client:
      | Pick<PrismaService, 'applicationActivity'>
      | Prisma.TransactionClient,
    input: AppendApplicationActivityInput,
  ): Promise<ApplicationActivity> {
    return client.applicationActivity.create({
      data: {
        applicationId: input.applicationId,
        type: input.type,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        visibility: input.visibility,
        occurredAt: input.occurredAt,
        payload: input.metadata,
      },
    });
  }
}
