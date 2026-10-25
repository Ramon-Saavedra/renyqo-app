import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { AppendApplicationActivityInput } from '../applications/application-activity.service';
import { providerApplicationIsVisible } from '../applications/application-process.policy';
import { notifiableActivity } from './notification.policy';

@Injectable()
export class NotificationProducer {
  async activity(
    tx: Prisma.TransactionClient,
    sourceActivityId: string,
    input: AppendApplicationActivityInput,
  ) {
    if (!notifiableActivity(input)) return;
    const app = await tx.application.findUniqueOrThrow({
      where: { id: input.applicationId },
      select: {
        id: true,
        listingId: true,
        applicantId: true,
        status: true,
        activeAt: true,
      },
    });
    // Keep relation reads sequential on the caller's single pg transaction connection.
    const listing = await tx.listing.findUniqueOrThrow({
      where: { id: app.listingId },
      select: { providerId: true },
    });
    const recipients: { id: string; side: 'APPLICANT' | 'PROVIDER' }[] = [];
    if (input.visibility !== 'PROVIDER' && input.actorType !== 'APPLICANT') {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: app.applicantId },
        select: { role: true, status: true },
      });
      if (user.role === 'APPLICANT' && user.status === 'ACTIVE')
        recipients.push({ id: app.applicantId, side: 'APPLICANT' });
    }
    if (
      input.visibility !== 'APPLICANT' &&
      input.actorType !== 'PROVIDER' &&
      providerApplicationIsVisible(app)
    ) {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: listing.providerId },
        select: { role: true, status: true },
      });
      if (user.role === 'PROVIDER' && user.status === 'ACTIVE')
        recipients.push({ id: listing.providerId, side: 'PROVIDER' });
    }
    const m = input.metadata;
    const workflowId =
      m?.workflowId ??
      (
        await tx.viewingWorkflow.findUnique({
          where: { applicationId: app.id },
          select: { id: true },
        })
      )?.id;
    for (const recipient of recipients) {
      if (
        input.type === 'VIEWING_CONSIDERATION_CHANGED' &&
        m?.appointmentId &&
        (await tx.notification.findFirst({
          where: {
            applicationId: app.id,
            recipientId: recipient.id,
            type: input.type,
            appointmentId: m.appointmentId,
          },
          select: { id: true },
        }))
      )
        continue;
      await tx.notification.upsert({
        where: {
          sourceActivityId_recipientId: {
            sourceActivityId,
            recipientId: recipient.id,
          },
        },
        create: {
          recipientId: recipient.id,
          recipientSide: recipient.side,
          sourceActivityId,
          applicationId: app.id,
          listingId: app.listingId,
          type: input.type,
          workflowId,
          proposalId: m?.proposalId,
          appointmentId:
            m?.appointmentId ??
            ([
              'VIEWING_ACCEPTED',
              'VIEWING_CANCELLED',
              'VIEWING_COMPLETED',
              'VIEWING_NO_SHOW',
              'VIEWING_OUTCOME_CORRECTED',
              'VIEWING_INTEREST_CONFIRMED',
            ].includes(input.type)
              ? m?.viewingId
              : undefined),
          section: input.type.startsWith('VIEWING_')
            ? 'VIEWING'
            : 'APPLICATION',
          occurredAt: input.occurredAt ?? new Date(),
        },
        update: {},
      });
    }
    // Creation already shares the application viewing/lifecycle invalidation.
    // Socket dispatch never controls this persistence.
  }
}
