import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import {
  ApplicationRejectionReason,
  ApplicationStatus,
  ListingEventType,
  ListingStatus,
} from '../generated/prisma/enums';
import { EligibilityService } from '../eligibility/eligibility.service';
import { ApplicationLifecycleReadService } from './application-lifecycle-read.service';
import type { ProviderExitedApplicationRecord } from './dto/provider-exited-application-response.dto';

export type ProviderRecentExitProjection = {
  id: string;
  listingId: string;
  status: ApplicationStatus;
  publicReason: ApplicationRejectionReason | null;
  activeAt: Date;
  exitedAt: Date;
};

export type ProviderRecentExitSelection = {
  items: ProviderRecentExitProjection[];
  totalCount: number;
};

export type ProviderRecentExitCardRecord = ProviderExitedApplicationRecord & {
  createdAt: Date;
  listing: { status: ListingStatus };
};

@Injectable()
export class ProviderRecentExitsQueryService {
  constructor(
    private readonly lifecycle: ApplicationLifecycleReadService,
    private readonly eligibility: EligibilityService,
  ) {}

  async select(
    tx: Prisma.TransactionClient,
    providerId: string,
    listingIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderRecentExitSelection>> {
    const groups = new Map<string, ProviderRecentExitSelection>(
      listingIds.map((id) => [id, { items: [], totalCount: 0 }]),
    );
    if (!listingIds.length) return groups;
    const rows = await tx.$queryRaw<
      (ProviderRecentExitProjection & { totalCount: bigint })[]
    >`
      WITH scoped AS (
        SELECT a.* FROM applications a
        JOIN listings l ON l.id = a.listing_id
        WHERE l.provider_id = ${providerId}::uuid
          AND a.listing_id = ANY(${[...listingIds]}::uuid[])
      ), latest AS (
        SELECT DISTINCT ON (listing_id, applicant_id) * FROM scoped
        ORDER BY listing_id, applicant_id, created_at DESC, id DESC
      ), transitions AS (
        SELECT s.id AS application_id, aa.id, aa.occurred_at,
          CASE WHEN aa.type = 'application_submitted' THEN aa.payload->>'initialStatus'
            ELSE aa.payload->>'toStatus' END AS status,
          aa.payload->>'reason' AS reason,
          CASE aa.type
            WHEN 'application_submitted' THEN aa.actor_type = 'applicant' AND aa.payload->>'initialStatus' IN ('ACTIVE', 'WAITING')
            WHEN 'application_promoted_to_active' THEN aa.actor_type = 'system' AND aa.payload->>'fromStatus' = 'WAITING' AND aa.payload->>'toStatus' = 'ACTIVE'
            WHEN 'application_restored' THEN aa.actor_type = 'provider' AND aa.payload->>'fromStatus' = 'REJECTED' AND aa.payload->>'toStatus' IN ('ACTIVE', 'WAITING')
            WHEN 'application_withdrawn' THEN aa.actor_type = 'applicant' AND aa.payload->>'fromStatus' IN ('ACTIVE', 'WAITING') AND aa.payload->>'toStatus' = 'WITHDRAWN'
            WHEN 'application_rejected' THEN aa.actor_type IN ('provider', 'system') AND aa.payload->>'fromStatus' IN ('ACTIVE', 'WAITING') AND aa.payload->>'toStatus' = 'REJECTED'
            WHEN 'application_accepted' THEN aa.payload->>'toStatus' = 'ACCEPTED'
            ELSE FALSE END AS valid
        FROM scoped s JOIN application_activities aa ON aa.application_id = s.id
        WHERE aa.type IN ('application_submitted', 'application_promoted_to_active',
          'application_rejected', 'application_restored', 'application_withdrawn', 'application_accepted')
        UNION ALL
        SELECT s.id, le.id, le.occurred_at, le.payload->>'toStatus', UPPER(le.reason),
          CASE le.type WHEN 'rejected_by_provider' THEN le.payload->>'fromStatus' = 'ACTIVE' AND le.payload->>'toStatus' = 'REJECTED'
            WHEN 'restored_by_provider' THEN le.payload->>'fromStatus' = 'REJECTED' AND le.payload->>'toStatus' IN ('ACTIVE', 'WAITING')
            ELSE FALSE END
        FROM scoped s JOIN listing_events le ON le.application_id = s.id
        WHERE le.source = 'provider' AND le.reason = 'NOT_SELECTED'
          AND le.type IN ('rejected_by_provider', 'restored_by_provider')
      ), active_entries AS (
        SELECT listing_id, applicant_id, active_at AS occurred_at FROM scoped
        WHERE active_at IS NOT NULL
        UNION ALL
        SELECT s.listing_id, s.applicant_id, t.occurred_at
        FROM scoped s JOIN transitions t ON t.application_id = s.id
        WHERE t.valid AND t.status = 'ACTIVE'
      ), exits AS (
        SELECT a.id, a.listing_id, a.applicant_id, UPPER(a.status::text) AS status,
          CASE WHEN a.status = 'withdrawn' THEN NULL ELSE UPPER(a.public_reason::text) END AS public_reason,
          CASE WHEN t.application_id IS NOT NULL THEN t.occurred_at
            WHEN a.status = 'withdrawn' THEN a.withdrawn_at ELSE a.rejected_at END AS exited_at
        FROM latest a
        LEFT JOIN LATERAL (
          SELECT * FROM transitions t WHERE t.application_id = a.id
          ORDER BY occurred_at DESC, id DESC LIMIT 1
        ) t ON TRUE
        WHERE a.status IN ('rejected', 'withdrawn')
          AND NOT EXISTS (
            SELECT 1 FROM scoped live WHERE live.listing_id = a.listing_id
              AND live.applicant_id = a.applicant_id AND live.status IN ('active', 'waiting')
          )
          AND (t.application_id IS NULL OR (
            t.valid AND t.status = UPPER(a.status::text)
            AND (a.status = 'withdrawn' OR t.reason = UPPER(a.public_reason::text))
          ))
          AND (a.status = 'withdrawn' OR a.public_reason IS NOT NULL)
      ), qualified AS (
        SELECT e.*, p.active_at FROM exits e
        JOIN LATERAL (
          SELECT MAX(occurred_at) AS active_at FROM active_entries p
          WHERE p.listing_id = e.listing_id AND p.applicant_id = e.applicant_id
            AND p.occurred_at <= e.exited_at
        ) p ON p.active_at IS NOT NULL
        WHERE e.exited_at IS NOT NULL
      ), ranked AS (
        SELECT *, COUNT(*) OVER (PARTITION BY listing_id) AS total_count,
          ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY exited_at DESC, id DESC) AS position
        FROM qualified
      )
      SELECT id, listing_id AS "listingId", status, public_reason AS "publicReason",
        active_at AS "activeAt", exited_at AS "exitedAt", total_count AS "totalCount"
      FROM ranked WHERE position <= 5 ORDER BY listing_id, position
    `;
    for (const row of rows) {
      const group = groups.get(row.listingId);
      if (!group) throw new Error('Unexpected recent-exit listing');
      const { totalCount, ...item } = row;
      group.items.push(item);
      group.totalCount = Number(totalCount);
    }
    return groups;
  }

  async cards(
    tx: Prisma.TransactionClient,
    providerId: string,
    projections: readonly ProviderRecentExitProjection[],
    asOf: Date,
  ): Promise<ProviderRecentExitCardRecord[]> {
    if (!projections.length) return [];
    const applications = await tx.application.findMany({
      where: {
        id: { in: projections.map((row) => row.id) },
        listing: { providerId },
      },
      select: {
        id: true,
        createdAt: true,
        status: true,
        publicReason: true,
        listing: {
          select: {
            status: true,
            minimumHouseholdNetIncome: true,
            schufaRequired: true,
            incomeProofRequired: true,
            suitableForPeopleCount: true,
            petsPolicy: true,
            smokingPolicy: true,
          },
        },
        applicant: {
          select: {
            name: true,
            profile: {
              select: {
                peopleCount: true,
                introduction: true,
                householdNetIncome: true,
                schufaAvailable: true,
                incomeProofAvailable: true,
                adultsCount: true,
                childrenCount: true,
                hasPets: true,
                isSmoker: true,
              },
            },
          },
        },
      },
    });
    const latestEventAt = new Map<string, Date>();
    if (applications.length) {
      const events = await tx.listingEvent.findMany({
        where: {
          applicationId: { in: applications.map((row) => row.id) },
          type: {
            in: [
              ListingEventType.REJECTED_BY_PROVIDER,
              ListingEventType.RESTORED_BY_PROVIDER,
            ],
          },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { applicationId: true, occurredAt: true },
      });
      for (const event of events) {
        if (!event.applicationId || latestEventAt.has(event.applicationId)) {
          continue;
        }
        latestEventAt.set(event.applicationId, event.occurredAt);
      }
    }
    const byId = new Map(applications.map((row) => [row.id, row]));
    return projections.map((projection) => {
      const application = byId.get(projection.id);
      if (!application) throw new Error('Missing recent-exit application');
      const profile = application.applicant.profile;
      return {
        ...projection,
        createdAt: application.createdAt,
        listing: { status: application.listing.status },
        canRestore: this.lifecycle.restoreAllowed(
          application,
          latestEventAt.get(application.id) ?? null,
          false,
          this.eligibility.evaluateCriteria(application.listing, profile)
            .canApply,
          asOf,
        ),
        applicant: {
          name: application.applicant.name,
          profile: profile
            ? {
                peopleCount: profile.peopleCount,
                introduction: profile.introduction,
              }
            : null,
        },
      };
    });
  }
}
