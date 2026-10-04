import { ApplicationDocumentState } from '../generated/prisma/enums';
import {
  documentCancelCapability,
  documentCancellationAllowed,
  documentReplacementAllowed,
  documentUploadAllowed,
  documentWasPublished,
} from './application-document.policy';

describe('Application document policy', () => {
  const mutable = true;
  const active = null as Date | null;

  it('allows cancellation only before a published document exists', () => {
    expect(documentCancellationAllowed(active, null, mutable)).toBe(true);
    expect(
      documentCancellationAllowed(
        active,
        {
          state: ApplicationDocumentState.FAILED,
          availableAt: null,
          reviewedAt: null,
        },
        mutable,
      ),
    ).toBe(true);
    expect(
      documentCancellationAllowed(
        active,
        {
          state: ApplicationDocumentState.PROCESSING,
          availableAt: null,
          reviewedAt: null,
        },
        mutable,
      ),
    ).toBe(false);
    expect(
      documentCancellationAllowed(
        active,
        {
          state: ApplicationDocumentState.AVAILABLE,
          availableAt: new Date(),
          reviewedAt: null,
        },
        mutable,
      ),
    ).toBe(false);
  });

  it('exposes provider-only cancel capability through the shared predicate', () => {
    expect(documentCancelCapability(active, null, mutable, 'provider')).toBe(
      true,
    );
    expect(documentCancelCapability(active, null, mutable, 'applicant')).toBe(
      false,
    );
    expect(
      documentCancelCapability(new Date(), null, mutable, 'provider'),
    ).toBe(false);
  });

  it('allows replacement only after a published document exists', () => {
    expect(documentReplacementAllowed(active, null, mutable, 'provider')).toBe(
      false,
    );
    expect(
      documentReplacementAllowed(
        active,
        {
          state: ApplicationDocumentState.PROCESSING,
          availableAt: null,
          reviewedAt: null,
        },
        mutable,
        'provider',
      ),
    ).toBe(false);
    const received = {
      state: ApplicationDocumentState.AVAILABLE,
      availableAt: new Date(),
      reviewedAt: null,
    };
    expect(
      documentReplacementAllowed(active, received, mutable, 'provider'),
    ).toBe(true);
    expect(
      documentReplacementAllowed(active, received, mutable, 'applicant'),
    ).toBe(false);
    expect(
      documentReplacementAllowed(
        active,
        {
          state: ApplicationDocumentState.AVAILABLE,
          availableAt: new Date(),
          reviewedAt: new Date(),
        },
        mutable,
        'provider',
      ),
    ).toBe(true);
  });

  it('treats published history as blocking cancellation even when state changed', () => {
    expect(
      documentWasPublished({
        state: ApplicationDocumentState.FAILED,
        availableAt: new Date(),
        reviewedAt: null,
      }),
    ).toBe(true);
    expect(
      documentUploadAllowed({
        state: ApplicationDocumentState.FAILED,
        availableAt: null,
        reviewedAt: null,
      }),
    ).toBe(true);
  });
});
