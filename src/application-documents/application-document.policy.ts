import { ApplicationDocumentState } from '../generated/prisma/enums';
import type { AttentionAudience } from '../application-attention/application-pending-action';

export type DocumentFileState = {
  state: ApplicationDocumentState;
  availableAt: Date | null;
  reviewedAt: Date | null;
};

export function documentWasPublished(
  file: DocumentFileState | null | undefined,
): boolean {
  return file?.availableAt != null;
}

export function documentCancellationAllowed(
  closedAt: Date | null,
  _file: DocumentFileState | null | undefined,
  mutable: boolean,
): boolean {
  if (!mutable || closedAt !== null) return false;
  return true;
}

export function documentCancelCapability(
  closedAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
  audience: AttentionAudience,
): boolean {
  return (
    audience === 'provider' &&
    documentCancellationAllowed(closedAt, file, mutable)
  );
}

export function documentReplacementAllowed(
  closedAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
  audience: AttentionAudience,
): boolean {
  if (audience !== 'provider' || !mutable || closedAt !== null) return false;
  if (!file || !documentWasPublished(file)) return false;
  if (file.state === ApplicationDocumentState.PROCESSING) return false;
  return true;
}

export function documentUploadAllowed(
  file: DocumentFileState | null | undefined,
): boolean {
  return (
    !file ||
    (file.state === ApplicationDocumentState.FAILED &&
      file.availableAt === null)
  );
}

export function documentReviewRequired(
  file: Pick<DocumentFileState, 'state' | 'reviewedAt'>,
): boolean {
  return (
    file.state === ApplicationDocumentState.AVAILABLE &&
    file.reviewedAt === null
  );
}

export function documentRequestCapabilities(
  closedAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
) {
  return {
    canUpload: mutable && closedAt === null && documentUploadAllowed(file),
    canReview:
      mutable && closedAt === null && !!file && documentReviewRequired(file),
  };
}

export function documentRequestStatus(
  closedAt: Date | null,
  file: DocumentFileState | null | undefined,
  state:
    'OPEN' | 'CANCELLED' | 'SUPERSEDED' | 'LEGACY_CLOSED_UNKNOWN' = closedAt
    ? 'SUPERSEDED'
    : 'OPEN',
) {
  return closedAt
    ? state === 'OPEN'
      ? 'LEGACY_CLOSED_UNKNOWN'
      : state
    : file?.state === ApplicationDocumentState.AVAILABLE
      ? file.reviewedAt
        ? ('REVIEWED' as const)
        : ('RECEIVED' as const)
      : file?.state === ApplicationDocumentState.PROCESSING
        ? ('PROCESSING' as const)
        : ('UPLOAD_REQUIRED' as const);
}
