import { ApplicantListingSummaryDto } from './applicant-listing-summary.dto';

export class ApplicantListingsPageDto {
  readonly items!: ApplicantListingSummaryDto[];
  readonly nextCursor!: string | null;
  readonly total!: number;

  constructor(
    items: ApplicantListingSummaryDto[],
    nextCursor: string | null,
    total: number,
  ) {
    this.items = items;
    this.nextCursor = nextCursor;
    this.total = total;
  }
}
