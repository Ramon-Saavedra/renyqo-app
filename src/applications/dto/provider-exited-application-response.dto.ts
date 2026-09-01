import type { Application, User } from '../../generated/prisma/client';
import type { ApplicationRejectionReason } from '../../generated/prisma/enums';

export type ProviderExitedApplicationRecord = Pick<
  Application,
  'id' | 'listingId' | 'status' | 'publicReason'
> & {
  applicant: Pick<User, 'name'>;
  exitedAt: Date;
};

export class ProviderExitedApplicationResponseDto {
  readonly id: string;
  readonly listingId: string;
  readonly applicantName: string;
  readonly status: Application['status'];
  readonly publicReason: ApplicationRejectionReason | null;
  readonly exitedAt: Date;

  constructor(application: ProviderExitedApplicationRecord) {
    this.id = application.id;
    this.listingId = application.listingId;
    this.applicantName = application.applicant.name;
    this.status = application.status;
    this.publicReason = application.publicReason;
    this.exitedAt = application.exitedAt;
  }
}

export class ProviderExitedApplicationsResponseDto {
  readonly items: ProviderExitedApplicationResponseDto[];
  readonly totalCount: number;

  constructor(result: {
    items: ProviderExitedApplicationRecord[];
    totalCount: number;
  }) {
    this.items = result.items.map(
      (item) => new ProviderExitedApplicationResponseDto(item),
    );
    this.totalCount = result.totalCount;
  }
}
