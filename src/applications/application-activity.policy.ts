import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationDocumentType,
  ApplicationStatus,
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

  for (const key of ['initialStatus', 'fromStatus', 'toStatus'] as const) {
    const status = Object.values(ApplicationStatus).find(
      (value) => value === record[key],
    );
    if (status) safePayload[key] = status;
  }

  return safePayload;
}
