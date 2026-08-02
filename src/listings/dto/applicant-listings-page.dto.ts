import { ApplicantListingSummaryDto } from './applicant-listing-summary.dto';

export class ApplicantListingsPageDto {
  readonly items!: ApplicantListingSummaryDto[];
  readonly nextCursor!: string | null;

  constructor(items: ApplicantListingSummaryDto[], nextCursor: string | null) {
    this.items = items;
    this.nextCursor = nextCursor;
  }
}
