import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import type { AppendApplicationActivityInput } from '../applications/application-activity.service';
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
    const recipients: { id: string; side: 'APPLICANT' | 'PROVIDER' }[] = [];
    if (input.visibility !== 'PROVIDER' && input.actorType !== 'APPLICANT') {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: app.applicantId },
        select: { role: true, status: true },
      });
      if (user.role === 'APPLICANT' && user.status === 'ACTIVE')
        recipients.push({ id: app.applicantId, side: 'APPLICANT' });
    }
    // Provider delivery is deliberately disabled until authorization-aware team
    // fan-out exists. Creator/responsible members are never fallback recipients.
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
