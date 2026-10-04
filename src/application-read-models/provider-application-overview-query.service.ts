import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ApplicationStatus } from '../generated/prisma/enums';
import {
  ApplicationAttentionSummaryDto,
  AttentionTotalsDto,
} from '../application-attention/dto/attention-response.dto';
import { providerApplicationVisibility } from '../applications/application-process.policy';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ReadModelPageQueryDto } from './dto/read-model-input.dto';
import {
  CompactListingDto,
  ProviderListingOverviewDto,
  ProviderListingApplicationOverviewDto,
  ProviderApplicationCardDto,
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
  constructor(private readonly workspace: ApplicationWorkspaceQueryService) {}

  private async summaries(
    tx: Prisma.TransactionClient,
    userId: string,
    listings: { id: string }[],
    asOf: Date,
    retainIds: readonly string[] = [],
  ) {
    const ids = listings.map((row) => row.id);
    const totals = new Map(
      ids.map((id) => [
        id,
        {
          active: 0,
          waiting: 0,
          exited: 0,
          actions: 0,
          actionable: 0,
          unread: 0,
        },
      ]),
    );
    const attention = new Map<string, ApplicationAttentionSummaryDto>();
    const retained = new Set(retainIds);
    if (!ids.length) return { totals, attention };
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
    const exits = await tx.application.groupBy({
      by: ['listingId'],
      where: {
        AND: [
          providerApplicationVisibility(userId),
          {
            listingId: { in: ids },
            activeAt: { not: null },
            status: {
              in: [ApplicationStatus.REJECTED, ApplicationStatus.WITHDRAWN],
            },
          },
        ],
      },
      _count: { _all: true },
    });
    for (const row of exits) {
      const total = totals.get(row.listingId);
      if (total) total.exited = row._count._all;
    }
    let cursor: string | undefined;
    for (;;) {
      const applications = await tx.application.findMany({
        where: {
          AND: [
            providerApplicationVisibility(userId),
            { listingId: { in: ids } },
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
        const summary = facts.attention.get(row.id);
        const total = totals.get(row.listingId);
        if (summary && total) {
          total.actions += summary.pendingActionCount;
          total.actionable += Number(summary.hasPendingAction);
          total.unread += summary.actionableUnreadMessageCount;
        }
        if (summary && retained.has(row.id))
          attention.set(
            row.id,
            new ApplicationAttentionSummaryDto(
              summary.pendingActionCount,
              summary.actionableUnreadMessageCount,
            ),
          );
      }
      if (applications.length < 200) break;
      cursor = applications.at(-1)?.id;
    }
    return { totals, attention };
  }

  overview(userId: string, query: ReadModelPageQueryDto) {
    const cursor = decodeReadModelCursor(query.cursor, 'listings');
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        const rows = await tx.listing.findMany({
          where: {
            providerId: userId,
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
        const totalCount = await tx.listing.count({
          where: { providerId: userId },
        });
        const { totals } = await this.summaries(tx, userId, page, asOf);
        const items = page.map((row) => {
          const total = totals.get(row.id);
          if (!total) throw new Error('Missing listing summary');
          return new ProviderListingOverviewDto(
            new CompactListingDto(row),
            total.active,
            total.waiting,
            total.exited,
            new AttentionTotalsDto(
              total.actionable,
              total.actions,
              total.unread,
            ),
          );
        });
        const hasMore = rows.length > query.limit;
        const last = page.at(-1);
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
                  value: last.displayOrder,
                })
              : null,
          ),
          totalCount,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  listing(userId: string, listingId: string) {
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        const listing = await tx.listing.findFirst({
          where: { id: listingId, providerId: userId },
          select: compactListingSelect,
        });
        if (!listing) throw new NotFoundException('Listing not found');
        const active = await tx.application.findMany({
          where: { listingId, status: ApplicationStatus.ACTIVE },
          select: providerApplicationSelect,
          orderBy: [{ activeAt: 'asc' }, { id: 'asc' }],
          take: 5,
        });
        const exits = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM applications WHERE listing_id = ${listingId}::uuid AND active_at IS NOT NULL AND status IN ('rejected', 'withdrawn')
        ORDER BY COALESCE(rejected_at, withdrawn_at) DESC NULLS LAST, id DESC LIMIT 5
      `;
        const exited = exits.length
          ? await tx.application.findMany({
              where: {
                AND: [
                  providerApplicationVisibility(userId),
                  { id: { in: exits.map((row) => row.id) } },
                ],
              },
              select: providerApplicationSelect,
            })
          : [];
        const exitOrder = new Map(exits.map((row, index) => [row.id, index]));
        exited.sort(
          (a, b) => (exitOrder.get(a.id) ?? 0) - (exitOrder.get(b.id) ?? 0),
        );
        const summaries = await this.summaries(
          tx,
          userId,
          [listing],
          asOf,
          [...active, ...exited].map((row) => row.id),
        );
        const totals = summaries.totals.get(listingId);
        if (!totals) throw new Error('Missing listing summary');
        const cards = (rows: typeof active) =>
          rows.map((row) => {
            const summary = summaries.attention.get(row.id);
            if (!summary) throw new Error('Missing application summary');
            return new ProviderApplicationCardDto(row, summary);
          });
        return new ProviderListingApplicationOverviewDto(
          asOf,
          new ProviderListingOverviewDto(
            new CompactListingDto(listing),
            totals.active,
            totals.waiting,
            totals.exited,
            new AttentionTotalsDto(
              totals.actionable,
              totals.actions,
              totals.unread,
            ),
          ),
          cards(active),
          cards(exited),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
