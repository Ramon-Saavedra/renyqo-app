import type {
  ApplicationAttentionResponseDto,
  ApplicationAttentionSummaryDto,
  AttentionTotalsDto,
} from '../../application-attention/dto/attention-response.dto';
import type { CompactConversationSummaryDto } from '../../application-conversation/dto/compact-conversation-summary.dto';
import type { ApplicationDocumentReadService } from '../../application-documents/application-document-read.service';
import type { ApplicationViewingReadService } from '../../application-viewings/application-viewing-read.service';
import type { ApplicationLifecycleReadService } from '../../applications/application-lifecycle-read.service';
import type { ApplicationActivityReadService } from '../../applications/application-activity-read.service';
import type {
  ReadModelApplication,
  ProviderReadModelApplication,
} from '../read-model-select';

export class CompactListingDto {
  readonly id: string;
  readonly title: string | null;
  readonly city: string | null;
  readonly coldRent: number | null;
  readonly status: ReadModelApplication['listing']['status'];
  constructor(
    listing: ReadModelApplication['listing'],
    readonly imageUrl: string | null = null,
  ) {
    this.id = listing.id;
    this.title = listing.title;
    this.city = listing.city;
    this.coldRent = listing.coldRent;
    this.status = listing.status;
  }
}

export class CompactApplicantDto {
  readonly name: string;
  readonly peopleCount: number | null;
  readonly introduction: string | null;
  constructor(applicant: ProviderReadModelApplication['applicant']) {
    this.name = applicant.name;
    this.peopleCount = applicant.profile?.peopleCount ?? null;
    this.introduction = applicant.profile?.introduction ?? null;
  }
}

export class ApplicationLifecycleSummaryDto {
  readonly id: string;
  readonly status: ReadModelApplication['status'];
  readonly submittedAt: Date;
  readonly activeAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly publicReason: ReadModelApplication['publicReason'];
  constructor(application: ReadModelApplication) {
    this.id = application.id;
    this.status = application.status;
    this.submittedAt = application.createdAt;
    this.activeAt = application.activeAt;
    this.rejectedAt = application.rejectedAt;
    this.withdrawnAt = application.withdrawnAt;
    this.publicReason = application.publicReason;
  }
}

export class ReadModelPaginationDto {
  constructor(
    readonly limit: number,
    readonly hasMore: boolean,
    readonly nextCursor: string | null,
  ) {}
}

export class ReadModelPageDto<T> {
  constructor(
    readonly asOf: Date,
    readonly items: T[],
    readonly pagination: ReadModelPaginationDto,
    readonly totalCount: number,
  ) {}
}

export class ProviderApplicationCardDto {
  readonly applicationId: string;
  readonly status: ReadModelApplication['status'];
  readonly activeAt: Date | null;
  readonly submittedAt: Date;
  readonly exitedAt: Date | null;
  readonly publicReason: ReadModelApplication['publicReason'];
  readonly applicant: CompactApplicantDto;
  constructor(
    application: ProviderReadModelApplication,
    readonly attention: ApplicationAttentionSummaryDto,
  ) {
    this.applicationId = application.id;
    this.status = application.status;
    this.activeAt = application.activeAt;
    this.submittedAt = application.createdAt;
    this.exitedAt = application.rejectedAt ?? application.withdrawnAt;
    this.publicReason = application.publicReason;
    this.applicant = new CompactApplicantDto(application.applicant);
  }
}

export class ApplicantApplicationCardDto {
  readonly applicationId: string;
  readonly status: ReadModelApplication['status'];
  readonly submittedAt: Date;
  readonly activeAt: Date | null;
  constructor(
    application: ReadModelApplication,
    readonly listing: CompactListingDto,
    readonly attention: ApplicationAttentionSummaryDto,
    readonly conversation: CompactConversationSummaryDto,
    readonly documents: ReturnType<
      ApplicationDocumentReadService['summary']
    >['counts'],
    readonly viewing: ReturnType<ApplicationViewingReadService['summary']>,
  ) {
    this.applicationId = application.id;
    this.status = application.status;
    this.submittedAt = application.createdAt;
    this.activeAt = application.activeAt;
  }
}

export class ProviderListingOverviewDto {
  constructor(
    readonly listing: CompactListingDto,
    readonly activeApplicationsCount: number,
    readonly waitingCount: number,
    readonly exitedApplicationsCount: number,
    readonly attention: AttentionTotalsDto,
  ) {}
}

export class ProviderListingApplicationOverviewDto extends ProviderListingOverviewDto {
  constructor(
    readonly asOf: Date,
    summary: ProviderListingOverviewDto,
    readonly activeApplications: ProviderApplicationCardDto[],
    readonly recentExits: ProviderApplicationCardDto[],
  ) {
    super(
      summary.listing,
      summary.activeApplicationsCount,
      summary.waitingCount,
      summary.exitedApplicationsCount,
      summary.attention,
    );
  }
}

export class ApplicationWorkspaceDto {
  constructor(
    readonly asOf: Date,
    readonly application: ApplicationLifecycleSummaryDto,
    readonly attention: ApplicationAttentionResponseDto,
    readonly conversationSummary: CompactConversationSummaryDto,
    readonly documentsSummary: ReturnType<
      ApplicationDocumentReadService['summary']
    >,
    readonly viewingSummary: ReturnType<
      ApplicationViewingReadService['summary']
    >,
    readonly activityPreview: Awaited<
      ReturnType<ApplicationActivityReadService['preview']>
    >,
    readonly capabilities: Awaited<
      ReturnType<ApplicationLifecycleReadService['capabilities']>
    >,
  ) {}
}

export class ProviderApplicationWorkspaceDto extends ApplicationWorkspaceDto {
  constructor(
    workspace: ApplicationWorkspaceDto,
    readonly applicant: CompactApplicantDto,
  ) {
    super(
      workspace.asOf,
      workspace.application,
      workspace.attention,
      workspace.conversationSummary,
      workspace.documentsSummary,
      workspace.viewingSummary,
      workspace.activityPreview,
      workspace.capabilities,
    );
  }
}

export class ApplicantApplicationWorkspaceDto extends ApplicationWorkspaceDto {
  constructor(
    workspace: ApplicationWorkspaceDto,
    readonly listing: CompactListingDto,
  ) {
    super(
      workspace.asOf,
      workspace.application,
      workspace.attention,
      workspace.conversationSummary,
      workspace.documentsSummary,
      workspace.viewingSummary,
      workspace.activityPreview,
      workspace.capabilities,
    );
  }
}
