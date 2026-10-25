import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationDocumentType,
  ApplicationStatus,
  ViewingCancellationReason,
  ViewingClosureReason,
  ViewingProviderConsideration,
} from '../generated/prisma/enums';
import type { ApplicationActivityMetadata } from './application-activity.service';
export function toPublicActivityPayload(
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
  if (record['viewingLifecycleContext'] === 'RESTORE_CLEANUP')
    safePayload.viewingLifecycleContext = 'RESTORE_CLEANUP';

  for (const key of [
    'viewingId',
    'previousViewingId',
    'workflowId',
    'proposalId',
    'previousProposalId',
    'appointmentId',
    'previousAppointmentId',
  ] as const) {
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
  for (const key of [
    'viewingRound',
    'outcomeRevision',
    'workflowRevision',
  ] as const) {
    const value = record[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      safePayload[key] = value;
  }

  const consideration = Object.values(ViewingProviderConsideration).find(
    (value) => value === record['providerConsideration'],
  );
  if (consideration) safePayload.providerConsideration = consideration;
  const closureReason = Object.values(ViewingClosureReason).find(
    (value) => value === record['viewingClosureReason'],
  );
  if (closureReason) safePayload.viewingClosureReason = closureReason;
  const cancellationReason = Object.values(ViewingCancellationReason).find(
    (value) => value === record['cancellationReason'],
  );
  if (cancellationReason) safePayload.cancellationReason = cancellationReason;

  if (typeof record['requestId'] === 'string')
    safePayload.requestId = record['requestId'];
  if (typeof record['documentType'] === 'string') {
    const type = Object.values(ApplicationDocumentType).find(
      (value) => value === record['documentType'],
    );
    if (type) safePayload.documentType = type;
  }

  for (const key of ['initialStatus', 'fromStatus', 'toStatus'] as const) {
    const status = Object.values(ApplicationStatus).find(
      (value) => value === record[key],
    );
    if (status) safePayload[key] = status;
  }

  return safePayload;
}
