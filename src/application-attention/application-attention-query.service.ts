import { emptyConversationFacts } from '../application-conversation/application-conversation-read.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  applicationProcessAllowsMutation,
  providerApplicationVisibility,
} from '../applications/application-process.policy';
import { ApplicationConversationReadService } from '../application-conversation/application-conversation-read.service';
import { ApplicationDocumentReadService } from '../application-documents/application-document-read.service';
import { ApplicationViewingReadService } from '../application-viewings/application-viewing-read.service';
import { ViewingClock } from '../application-viewings/application-viewing.policy';
import type { AttentionAudience } from './application-pending-action';
import { ApplicationPendingActionService } from './application-pending-action.service';
import { AttentionQueryDto } from './dto/attention-input.dto';
import {
  projectApplicationAttention,
  summarizeAttentionTotals,
} from './attention-projection';
import {
  ApplicationAttentionResponseDto,
  ApplicationAttentionSummaryDto,
  ApplicationAttentionListItemDto,
  AttentionAggregateResponseDto,
  AttentionBatchResponseDto,
  AttentionPaginationDto,
  AttentionTotalsDto,
  ListingAttentionTotalsDto,
} from './dto/attention-response.dto';

const attentionCompositionApplicationSelect = {
  id: true,
  listingId: true,
  status: true,
  listing: { select: { status: true } },
} satisfies Prisma.ApplicationSelect;

const attentionListItemApplicationSelect = {
  ...attentionCompositionApplicationSelect,
  listing: { select: { status: true, title: true, city: true } },
} satisfies Prisma.ApplicationSelect;

type AttentionCompositionApplication = Prisma.ApplicationGetPayload<{
  select: typeof attentionCompositionApplicationSelect;
}>;

type AttentionListItemApplication = Prisma.ApplicationGetPayload<{
  select: typeof attentionListItemApplicationSelect;
}>;

@Injectable()
export class ApplicationAttentionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pending: ApplicationPendingActionService,
    private readonly conversations: ApplicationConversationReadService,
    private readonly documents: ApplicationDocumentReadService,
    private readonly viewings: ApplicationViewingReadService,
    private readonly clock: ViewingClock,
  ) {}

  detail(
    userId: string,
    audience: AttentionAudience,
    applicationId: string,
  ): Promise<ApplicationAttentionResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = this.clock.now();
        const applications = await tx.application.findMany({
          where: { AND: [this.scope(userId, audience), { id: applicationId }] },
          select: attentionCompositionApplicationSelect,
        });
        if (!applications.length)
          throw new NotFoundException('Application not found');
        const rows = await this.deriveBatch(tx, applications, audience, asOf);
        const response = rows.get(applicationId);
        if (!response) throw new NotFoundException('Application not found');
        return response;
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  batch(
    userId: string,
    audience: AttentionAudience,
    applicationIds: readonly string[],
  ): Promise<AttentionBatchResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = this.clock.now();
        const ids = [...new Set(applicationIds)];
        const items: ApplicationAttentionListItemDto[] = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          const requested = ids.slice(offset, offset + 200);
          const applications = await tx.application.findMany({
            where: {
              AND: [this.scope(userId, audience), { id: { in: requested } }],
            },
            select: attentionListItemApplicationSelect,
            orderBy: { id: 'asc' },
          });
          if (applications.length !== requested.length)
            throw new NotFoundException('Application not found');
          const rows = await this.deriveBatch(tx, applications, audience, asOf);
          for (const application of applications) {
            const summary = rows.get(application.id);
            if (summary) items.push(this.toListItem(application, summary));
          }
        }
        items.sort((a, b) =>
          a.applicationId < b.applicationId
            ? -1
            : a.applicationId > b.applicationId
              ? 1
              : 0,
        );
        return new AttentionBatchResponseDto(asOf, items);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  aggregate(
    userId: string,
    audience: AttentionAudience,
    query: AttentionQueryDto,
    listingId?: string,
  ): Promise<AttentionAggregateResponseDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = this.clock.now();
        const listings =
          audience === 'provider'
            ? await tx.listing.findMany({
                where: {
                  providerId: userId,
                  ...(listingId ? { id: listingId } : {}),
                },
                select: { id: true },
                orderBy: { id: 'asc' },
              })
            : [];
        if (listingId && !listings.length)
          throw new NotFoundException('Listing not found');
        const listingItems = new Map<string, ApplicationAttentionListItemDto[]>(
          listings.map((row) => [row.id, []]),
        );
        const all: ApplicationAttentionListItemDto[] = [];
        let nextRevalidateAt: Date | null = null;
        const listingRevalidations = new Map<string, Date>();
        let cursor: string | undefined;
        for (;;) {
          const applications = await tx.application.findMany({
            where: {
              AND: [
                this.scope(userId, audience),
                listingId ? { listingId } : {},
              ],
            },
            select: attentionListItemApplicationSelect,
            orderBy: { id: 'asc' },
            take: 200,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (!applications.length) break;
          const rows = await this.deriveBatch(tx, applications, audience, asOf);
          for (const application of applications) {
            const summary = rows.get(application.id);
            if (!summary) continue;
            const item = this.toListItem(application, summary);
            if (!listingItems.has(application.listingId))
              listingItems.set(application.listingId, []);
            // Quiet applications can acquire viewing obligations as time passes.
            // Keep their refresh boundaries even when they are not menu entries.
            const boundary = item.nextRevalidateAt;
            if (boundary) {
              if (!nextRevalidateAt || boundary < nextRevalidateAt)
                nextRevalidateAt = boundary;
              const previous = listingRevalidations.get(application.listingId);
              if (!previous || boundary < previous)
                listingRevalidations.set(application.listingId, boundary);
            }
            if (
              query.filter === 'actionable' &&
              !item.hasPendingAction &&
              item.actionableUnreadMessageCount === 0
            )
              continue;
            all.push(item);
            const group = listingItems.get(application.listingId) ?? [];
            group.push(item);
            listingItems.set(application.listingId, group);
          }
          if (applications.length < 200) break;
          cursor = applications.at(-1)?.id;
        }
        if (query.filter === 'actionable') {
          // Obligations precede message-only attention; IDs break all ties.
          all.sort(
            (a, b) =>
              Number(b.hasPendingAction) - Number(a.hasPendingAction) ||
              b.pendingActionCount - a.pendingActionCount ||
              b.actionableUnreadMessageCount - a.actionableUnreadMessageCount ||
              (a.applicationId < b.applicationId
                ? -1
                : a.applicationId > b.applicationId
                  ? 1
                  : 0),
          );
        }
        return new AttentionAggregateResponseDto(
          asOf,
          this.totals(all, nextRevalidateAt),
          [...listingItems]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(
              ([id, items]) =>
                new ListingAttentionTotalsDto(
                  id,
                  this.totals(items, listingRevalidations.get(id) ?? null),
                ),
            ),
          all.slice(query.offset, query.offset + query.limit),
          new AttentionPaginationDto(query.offset, query.limit, all.length),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private scope(
    userId: string,
    audience: AttentionAudience,
  ): Prisma.ApplicationWhereInput {
    return audience === 'provider'
      ? providerApplicationVisibility(userId)
      : { applicantId: userId };
  }

  private async deriveBatch(
    tx: Prisma.TransactionClient,
    applications: readonly AttentionCompositionApplication[],
    audience: AttentionAudience,
    asOf: Date,
  ) {
    return (
      await this.composeWithinTransaction(tx, applications, audience, asOf)
    ).attention;
  }

  async composeWithinTransaction(
    tx: Prisma.TransactionClient,
    applications: readonly AttentionCompositionApplication[],
    audience: AttentionAudience,
    asOf: Date,
  ) {
    const result = new Map<string, ApplicationAttentionResponseDto>();
    const ids = applications.map((row) => row.id);
    const conversations = await this.conversations.batch(
      tx,
      ids,
      audience === 'provider'
        ? ConversationSide.PROVIDER
        : ConversationSide.APPLICANT,
    );
    const documents = await this.documents.batch(tx, ids);
    const viewings = await this.viewings.batch(tx, ids);
    const documentGroups = new Map<string, typeof documents>();
    for (const row of documents) {
      const group = documentGroups.get(row.applicationId) ?? [];
      group.push(row);
      documentGroups.set(row.applicationId, group);
    }
    const viewingGroups = new Map<string, typeof viewings.rows>();
    for (const row of viewings.rows) {
      const group = viewingGroups.get(row.applicationId) ?? [];
      group.push(row);
      viewingGroups.set(row.applicationId, group);
    }
    for (const application of applications) {
      const mutable = applicationProcessAllowsMutation(application);
      const documentRows = documentGroups.get(application.id) ?? [];
      const viewingFacts = this.viewings.facts(
        viewingGroups.get(application.id) ?? [],
        mutable,
        viewings.rounds.get(application.id),
        asOf,
      );
      const derived = this.pending.derive(
        application,
        audience,
        conversations.get(application.id) ?? emptyConversationFacts,
        this.documents.facts(documentRows, mutable),
        viewingFacts,
        asOf,
      );
      result.set(
        application.id,
        projectApplicationAttention({
          applicationId: application.id,
          listingId: application.listingId,
          pendingActions: derived.pendingActions,
          actionableUnreadMessageCount: derived.actionableUnreadMessageCount,
          historicalUnreadMessageCount: derived.historicalUnreadMessageCount,
          conversation: derived.conversation,
          asOf,
          documents: documentRows,
          revalidatesAt: viewingFacts.flatMap((fact) =>
            fact.revalidatesAt ? [fact.revalidatesAt] : [],
          ),
        }),
      );
    }
    return { attention: result, conversations, documents, viewings };
  }

  private totals(
    items: readonly ApplicationAttentionListItemDto[],
    nextRevalidateAt: Date | null,
  ): AttentionTotalsDto {
    const totals = summarizeAttentionTotals(items);
    return new AttentionTotalsDto(
      totals.applicationsWithPendingActions,
      totals.totalPendingActions,
      totals.actionableUnreadMessageCount,
      totals.categories,
      nextRevalidateAt,
    );
  }

  private toListItem(
    application: AttentionListItemApplication,
    summary: ApplicationAttentionSummaryDto,
  ): ApplicationAttentionListItemDto {
    return new ApplicationAttentionListItemDto(
      application.id,
      application.listingId,
      application.listing.title,
      application.listing.city,
      summary,
    );
  }
}
