import { Injectable } from '@nestjs/common';
import type { Listing, Prisma } from '../generated/prisma/client';
import { CriteriaRevisionSource } from '../generated/prisma/enums';

export const CRITERIA_FIELDS = [
  'minimumHouseholdNetIncome',
  'suitableForPeopleCount',
  'petsPolicy',
  'smokingPolicy',
  'schufaRequired',
  'incomeProofRequired',
] as const;
export function criteriaValues(
  listing: Pick<Listing, (typeof CRITERIA_FIELDS)[number]>,
) {
  return {
    minimumHouseholdNetIncome: listing.minimumHouseholdNetIncome,
    suitableForPeopleCount: listing.suitableForPeopleCount,
    petsPolicy: listing.petsPolicy,
    smokingPolicy: listing.smokingPolicy,
    schufaRequired: listing.schufaRequired,
    incomeProofRequired: listing.incomeProofRequired,
  };
}
@Injectable()
export class ListingCriteriaRevisionService {
  // Caller holds the listing lock, including on retries. No historical snapshot is fabricated.
  async current(
    tx: Prisma.TransactionClient,
    listing: Listing,
    actorUserId?: string,
    source: CriteriaRevisionSource = CriteriaRevisionSource.LEGACY_BASELINE,
  ) {
    const latest = await tx.listingCriteriaRevision.findFirst({
      where: { listingId: listing.id },
      orderBy: { revision: 'desc' },
    });
    if (latest) {
      if (CRITERIA_FIELDS.some((field) => latest[field] !== listing[field]))
        throw new Error('Listing criteria revision is out of sync');
      return latest;
    }
    return tx.listingCriteriaRevision.create({
      data: {
        listingId: listing.id,
        revision: 1,
        source,
        actorUserId,
        ...criteriaValues(listing),
      },
    });
  }
  async changed(
    tx: Prisma.TransactionClient,
    before: Listing,
    after: Listing,
    actorUserId: string,
  ) {
    if (!CRITERIA_FIELDS.some((field) => before[field] !== after[field]))
      return null;
    const previous = await this.current(tx, before);
    return tx.listingCriteriaRevision.create({
      data: {
        listingId: after.id,
        revision: previous.revision + 1,
        source: CriteriaRevisionSource.NATIVE,
        actorUserId,
        ...criteriaValues(after),
      },
    });
  }
}
