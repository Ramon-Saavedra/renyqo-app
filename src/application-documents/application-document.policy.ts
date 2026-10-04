import { ApplicationDocumentState } from '../generated/prisma/enums';

export type DocumentFileState = {
  state: ApplicationDocumentState;
  availableAt: Date | null;
  reviewedAt: Date | null;
};

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
