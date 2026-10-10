import { Injectable } from '@nestjs/common';
import type { ApplicantProfile, Application } from '../generated/prisma/client';
import {
  ApplicationLifecycleService,
  type ApplicationTransactionClient,
} from './application-lifecycle.service';
import { ApplicationProcessQueryService } from './application-process-query.service';
import type { BlockingApplicationState } from './applicant-listing-application-state';
import type { ApplicantApplicationRecord } from './dto/applicant-application-response.dto';
import type { ProviderActiveApplicationRecord } from './dto/provider-active-application-response.dto';
import type { ProviderExitedApplicationRecord } from './dto/provider-exited-application-response.dto';
import { ProviderApplicationCurationService } from './provider-application-curation.service';
import type { ApplicationAdmission } from './application-admission.service';

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly lifecycleService: ApplicationLifecycleService,
    private readonly curationService: ProviderApplicationCurationService,
    private readonly queryService: ApplicationProcessQueryService,
  ) {}

  apply(listingId: string, applicantId: string): Promise<Application> {
    return this.lifecycleService.apply(listingId, applicantId);
  }

  findAdmissionForListings(
    applicantId: string,
    listings: readonly { id: string; eligible: boolean }[],
    asOf: Date,
  ): Promise<ReadonlyMap<string, ApplicationAdmission>> {
    return this.queryService.findAdmissionForListings(
      applicantId,
      listings,
      asOf,
    );
  }

  withdraw(applicationId: string, applicantId: string): Promise<Application> {
    return this.lifecycleService.withdraw(applicationId, applicantId);
  }

  reject(applicationId: string, providerId: string): Promise<Application> {
    return this.curationService.reject(applicationId, providerId);
  }

  restore(applicationId: string, providerId: string): Promise<Application> {
    return this.curationService.restore(applicationId, providerId);
  }

  promoteWaitingApplications(listingId: string): Promise<number> {
    return this.lifecycleService.promoteWaitingApplications(listingId);
  }

  revalidateActiveAndWaitingApplications(
    tx: ApplicationTransactionClient,
    applicantId: string,
    profile: ApplicantProfile,
  ): Promise<void> {
    return this.lifecycleService.revalidateActiveAndWaitingApplications(
      tx,
      applicantId,
      profile,
    );
  }

  findAllByApplicantWithListing(
    applicantId: string,
  ): Promise<ApplicantApplicationRecord[]> {
    return this.queryService.findAllByApplicantWithListing(applicantId);
  }

  findBlockingApplicationsForListings(
    applicantId: string,
    listingIds: readonly string[],
  ): Promise<ReadonlyMap<string, BlockingApplicationState>> {
    return this.queryService.findBlockingApplicationsForListings(
      applicantId,
      listingIds,
    );
  }

  findBlockingApplicationForListing(
    applicantId: string,
    listingId: string,
  ): Promise<BlockingApplicationState | undefined> {
    return this.queryService.findBlockingApplicationForListing(
      applicantId,
      listingId,
    );
  }

  findAllByProvider(providerId: string): Promise<Application[]> {
    return this.queryService.findAllByProvider(providerId);
  }

  findAllByListing(
    listingId: string,
    providerId: string,
  ): Promise<Application[]> {
    return this.queryService.findAllByListing(listingId, providerId);
  }

  findWaitingCountByListing(
    listingId: string,
    providerId: string,
  ): Promise<number> {
    return this.queryService.findWaitingCountByListing(listingId, providerId);
  }

  findActiveByListing(
    listingId: string,
    providerId: string,
  ): Promise<ProviderActiveApplicationRecord[]> {
    return this.queryService.findActiveByListing(listingId, providerId);
  }

  findExitedByListing(
    listingId: string,
    providerId: string,
  ): Promise<{ items: ProviderExitedApplicationRecord[]; totalCount: number }> {
    return this.queryService.findExitedByListing(listingId, providerId);
  }
}
