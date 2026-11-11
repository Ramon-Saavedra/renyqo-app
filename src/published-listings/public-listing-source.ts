import type { PublicListingProjection } from '../generated/prisma/client';

// This is an explicit public allowlist model, not a spread of base Listing.
// Existing applicant-facing requirements remain public by product decision.
export function publicListingSource(row: PublicListingProjection) {
  return {
    ...row,
    street: row.publicStreet,
    showExactAddress: row.publicStreet !== null,
    images: row.photos.map((secureUrl, position) => ({
      secureUrl,
      position,
      isCover: position === 0,
    })),
  };
}
