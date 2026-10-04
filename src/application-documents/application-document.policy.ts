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
  supersededAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
): boolean {
  if (!mutable || supersededAt !== null) return false;
  if (documentWasPublished(file)) return false;
  if (file?.state === ApplicationDocumentState.PROCESSING) return false;
  return true;
}

export function documentCancelCapability(
  supersededAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
  audience: AttentionAudience,
): boolean {
  return (
    audience === 'provider' &&
    documentCancellationAllowed(supersededAt, file, mutable)
  );
}

export function documentReplacementAllowed(
  supersededAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
  audience: AttentionAudience,
): boolean {
  if (audience !== 'provider' || !mutable || supersededAt !== null)
    return false;
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
  supersededAt: Date | null,
  file: DocumentFileState | null | undefined,
  mutable: boolean,
) {
  return {
    canUpload: mutable && supersededAt === null && documentUploadAllowed(file),
    canReview:
      mutable &&
      supersededAt === null &&
      !!file &&
      documentReviewRequired(file),
  };
}

export function documentRequestStatus(
  supersededAt: Date | null,
  file: DocumentFileState | null | undefined,
) {
  return supersededAt
    ? ('SUPERSEDED' as const)
    : file?.state === ApplicationDocumentState.AVAILABLE
      ? file.reviewedAt
        ? ('REVIEWED' as const)
        : ('RECEIVED' as const)
      : file?.state === ApplicationDocumentState.PROCESSING
        ? ('PROCESSING' as const)
        : ('UPLOAD_REQUIRED' as const);
}
