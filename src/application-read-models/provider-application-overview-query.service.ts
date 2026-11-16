import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
import {
  ProviderListingAccess,
  providerListingWhere,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import { activeConsiderationOrder } from '../applications/application-consideration-read';
import { Prisma } from '../generated/prisma/client';
import { ApplicationStatus } from '../generated/prisma/enums';
import {
  AttentionTotalAccumulator,
  compactAttentionSummary,
} from '../application-attention/attention-projection';
import { ApplicationAttentionSummaryDto } from '../application-attention/dto/attention-response.dto';
import { providerApplicationVisibility } from '../applications/application-process.policy';
import {
  ProviderRecentExitsQueryService,
  type ProviderRecentExitSelection,
} from '../applications/provider-recent-exits-query.service';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ReadModelPageQueryDto } from './dto/read-model-input.dto';
import {
  CompactListingDto,
  ProviderListingOverviewDto,
  ProviderListingApplicationOverviewDto,
  ProviderApplicationCardDto,
  ProviderRecentExitCardDto,
  ReadModelPageDto,
  ReadModelPaginationDto,
} from './dto/read-model-response.dto';
import {
  compactListingSelect,
  providerApplicationSelect,
  readModelApplicationSelect,
} from './read-model-select';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
} from './read-model-cursor';

@Injectable()
export class ProviderApplicationOverviewQueryService {
  constructor(
    private readonly workspace: ApplicationWorkspaceQueryService,
    private readonly recentExits: ProviderRecentExitsQueryService,
    private readonly listings: ProviderListingAccess,
  ) {}

  private async summaries(
    tx: Prisma.TransactionClient,
    context: AuthorizationContext,
    listings: { id: string }[],
    asOf: Date,
    retainIds: readonly string[] = [],
    exitSelections?: ReadonlyMap<string, ProviderRecentExitSelection>,
  ) {
    const ids = listings.map((row) => row.id);
    const totals = new Map(
      ids.map((id) => [
        id,
        {
          active: 0,
          waiting: 0,
          exited: 0,
          attention: new AttentionTotalAccumulator(),
        },
      ]),
    );
    const attention = new Map<string, ApplicationAttentionSummaryDto>();
    const references: { applicationId: string; listingId: string }[] = [];
    const retained = new Set(retainIds);
    if (!ids.length) return { totals, attention, references };
    const counts = await tx.application.groupBy({
      by: ['listingId', 'status'],
      where: {
        listingId: { in: ids },
        status: { in: [ApplicationStatus.ACTIVE, ApplicationStatus.WAITING] },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      const total = totals.get(row.listingId);
      if (total) {
        if (row.status === ApplicationStatus.ACTIVE)
          total.active = row._count._all;
        else total.waiting = row._count._all;
      }
    }
    const exits =
      exitSelections ?? (await this.recentExits.select(tx, context, ids));
    for (const [listingId, selection] of exits) {
      const total = totals.get(listingId);
      if (total) total.exited = selection.totalCount;
    }
    let cursor: string | undefined;
    for (;;) {
      const applications = await tx.application.findMany({
        where: {
          AND: [
            providerApplicationVisibility(context),
            { listingId: { in: ids } },
            // Retain attendance/correction candidates even after termination.
            // Skip only inactive rows without potentially relevant viewing history.
            {
              OR: [
                {
                  status: ApplicationStatus.ACTIVE,
                  listing: { status: { in: ['PUBLISHED', 'PAUSED'] } },
                },
                { id: { in: [...retained] } },
                {
                  viewings: {
                    some: {
                      status: {
                        in: [
                          'ACCEPTED',
                          'OUTCOME_PENDING',
                          'COMPLETED',
                          'NO_SHOW',
                        ],
                      },
                    },
                  },
                },
              ],
            },
            cursor ? { id: { gt: cursor } } : {},
          ],
        },
        select: readModelApplicationSelect,
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (!applications.length) break;
      const facts = await this.workspace.attention.composeWithinTransaction(
        tx,
        applications,
        'provider',
        asOf,
      );
      for (const row of applications) {
        references.push({ applicationId: row.id, listingId: row.listingId });
        const summary = facts.attention.get(row.id);
        const total = totals.get(row.listingId);
        if (summary && total) total.attention.add(summary);
        if (summary && retained.has(row.id))
          attention.set(row.id, compactAttentionSummary(summary));
      }
      if (applications.length < 200) break;
      cursor = applications.at(-1)?.id;
    }
    return { totals, attention, references };
  }

  async overview(actor: ProviderActor, query: ReadModelPageQueryDto) {
    const cursor = decodeReadModelCursor(query.cursor, 'listings');
    const listingReferences: string[] = [];
    const applicationReferences: {
      applicationId: string;
      listingId: string;
    }[] = [];
    const result = await this.listings.read(
      actor,
      'listing.overview',
      undefined,
      async (tx, context) => {
        const asOf = this.workspace.clock.now();
        const rows = await tx.listing.findMany({
          where: {
            ...providerListingWhere(context),
            status: { not: 'RETIRED' },
            ...(cursor
              ? {
                  OR: [
                    { displayOrder: { gt: Number(cursor.value) } },
                    {
                      displayOrder: Number(cursor.value),
                      id: { gt: cursor.id },
                    },
                  ],
                }
              : {}),
          },
          select: { ...compactListingSelect, displayOrder: true },
          orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        // Off-page listings contribute totalCount too. Retain their identities,
        // not only page headers, so a compensating assignment cannot mask loss.
        const contributingListings = await tx.listing.findMany({
          where: {
            ...providerListingWhere(context),
            status: { not: 'RETIRED' },
          },
          select: { id: true },
        });
        listingReferences.push(...contributingListings.map((row) => row.id));
        const { totals, references } = await this.summaries(
          tx,
          context,
          page,
          asOf,
        );
        applicationReferences.push(...references);
        const images = await this.workspace.coverImages(
          tx,
          page.map((row) => row.id),
        );
        const items = page.map((row) => {
          const total = totals.get(row.id);
          if (!total) throw new Error('Missing listing summary');
          return new ProviderListingOverviewDto(
            new CompactListingDto(row, images.get(row.id) ?? null),
            total.active,
            total.waiting,
            total.exited,
            total.attention.toDto(),
          );
        });
        const hasMore = rows.length > query.limit;
        const last = page.at(-1);
        if (last && last.displayOrder === null)
          throw new Error('Operational listing requires display order');
        return new ReadModelPageDto(
          asOf,
          items,
          new ReadModelPaginationDto(
            query.limit,
            hasMore,
            hasMore && last
              ? encodeReadModelCursor({
                  kind: 'listings',
                  id: last.id,
                  value: last.displayOrder!,
                })
              : null,
          ),
          contributingListings.length,
        );
      },
    );
    // Fresh authoritative scope after all snapshot composition. This includes
    // headers without applications, pagination/count contributors and attention
    // Application -> Listing references; tenant RLS alone cannot prove assignment.
    await this.workspace.listingAccess.assertResultScope(
      actor,
      'provider',
      applicationReferences,
      listingReferences,
      'listing.overview',
    );
    return result;
  }

  listing(actor: ProviderActor, listingId: string) {
    return this.listings.read(
      actor,
      'listing.application-overview',
      listingId,
      async (tx, context) => {
        const asOf = this.workspace.clock.now();
        const listing = await tx.listing.findFirst({
          where: { id: listingId, ...providerListingWhere(context) },
          select: compactListingSelect,
        });
        if (!listing) throw new NotFoundException('Listing not found');
        const images = await this.workspace.coverImages(tx, [listing.id]);
        const active = await tx.application.findMany({
          where: { listingId, status: ApplicationStatus.ACTIVE },
          select: providerApplicationSelect,
          orderBy: activeConsiderationOrder,
          take: 5,
        });
        const exits = await this.recentExits.select(tx, context, [listingId]);
        const selection = exits.get(listingId);
        if (!selection) throw new Error('Missing recent-exit selection');
        const exited = await this.recentExits.cards(
          tx,
          context,
          selection.items,
          asOf,
        );
        const exitFacts =
          await this.workspace.attention.composeWithinTransaction(
            tx,
            exited,
            'provider',
            asOf,
          );
        const summaries = await this.summaries(
          tx,
          context,
          [listing],
          asOf,
          active.map((row) => row.id),
          exits,
        );
        const totals = summaries.totals.get(listingId);
        if (!totals) throw new Error('Missing listing summary');
        const consideration = await this.workspace.consideration.batch(
          tx,
          active.map((row) => row.id),
        );
        const cards = (rows: typeof active) =>
          rows.map((row) => {
            const summary = summaries.attention.get(row.id);
            if (!summary) throw new Error('Missing application summary');
            return new ProviderApplicationCardDto(
              row,
              summary,
              consideration.get(row.id),
            );
          });
        return new ProviderListingApplicationOverviewDto(
          asOf,
          new ProviderListingOverviewDto(
            new CompactListingDto(listing, images.get(listing.id) ?? null),
            totals.active,
            totals.waiting,
            totals.exited,
            totals.attention.toDto(),
          ),
          cards(active),
          exited.map((row) => {
            const attention = exitFacts.attention.get(row.id);
            if (!attention) throw new Error('Missing recent-exit attention');
            return new ProviderRecentExitCardDto(
              row,
              compactAttentionSummary(attention),
            );
          }),
        );
      },
    );
  }
}
