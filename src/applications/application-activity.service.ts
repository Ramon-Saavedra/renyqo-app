import {
  ApplicationOutboxProducer,
  applicationInvalidationType,
} from '../outbox/application-outbox.producer';
import { toPublicActivityPayload } from './application-activity.policy';
import { randomUUID } from 'node:crypto';
import { NotificationProducer } from '../notifications/notification-producer.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { ApplicationActivity, Prisma } from '../generated/prisma/client';
import {
  ApplicationActivityActorType,
  ApplicationActivityType,
  ApplicationActivityVisibility,
  ApplicationRejectionReason,
  ApplicationStatus,
  ApplicationDocumentType,
  ViewingCancellationReason,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export type ApplicationActivityMetadata = {
  viewingLifecycleContext?: 'RESTORE_CLEANUP';
  counterproposal?: boolean;
  providerConsideration?: import('../generated/prisma/enums').ViewingProviderConsideration;
  viewingClosureReason?: import('../generated/prisma/enums').ViewingClosureReason;
  workflowId?: string;
  workflowRevision?: number;
  proposalId?: string;
  previousProposalId?: string;
  appointmentId?: string;
  previousAppointmentId?: string;
  cancellationReason?: ViewingCancellationReason;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly invalidation: ApplicationOutboxProducer,
    private readonly notifications: NotificationProducer,
  ) {}

  append(input: AppendApplicationActivityInput): Promise<ApplicationActivity> {
    if (applicationInvalidationType(input.type))
      return this.prisma.$transaction((tx) =>
        this.appendWithinTransaction(tx, input),
      );
    return this.create(this.prisma, input);
  }

  async appendWithinTransaction(
    tx: Prisma.TransactionClient,
    input: AppendApplicationActivityInput,
  ): Promise<ApplicationActivity> {
    const row = await this.create(tx, input);
    await this.invalidation.activity(tx, {
      ...input,
      occurredAt: row.occurredAt,
    });
    await this.notifications.activity(tx, row.id, {
      ...input,
      occurredAt: row.occurredAt,
    });
    return row;
  }

  async appendManyWithinTransaction(
    tx: Prisma.TransactionClient,
    inputs: AppendApplicationActivityInput[],
  ): Promise<Prisma.BatchPayload> {
    if (inputs.length === 0) {
      return Promise.resolve({ count: 0 });
    }

    const ids = inputs.map(() => randomUUID());
    const occurredAt = new Date();
    const events = inputs.map((input) => ({
      ...input,
      occurredAt: input.occurredAt ?? occurredAt,
    }));
    const result = await tx.applicationActivity.createMany({
      data: events.map((input, index) => ({
        id: ids[index],
        applicationId: input.applicationId,
        type: input.type,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        visibility: input.visibility,
        occurredAt: input.occurredAt,
        payload: input.metadata,
      })),
    });
    for (const [index, input] of events.entries()) {
      await this.invalidation.activity(tx, input);
      await this.notifications.activity(tx, ids[index], input);
    }
    return result;
  }

  lifecycleChangedForListingWithinTransaction(
    tx: Prisma.TransactionClient,
    listingId: string,
    occurredAt: Date,
  ) {
    return this.invalidation.listing(tx, listingId, occurredAt);
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
    const payload = toPublicActivityPayload(activity.payload);

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
