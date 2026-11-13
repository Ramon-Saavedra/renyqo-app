import { emptyConversationFacts } from '../application-conversation/application-conversation-read.service';
import {
  ApplicationListingAccess,
  actorUserId,
  type ApplicationActor,
} from '../listings/application-listing-access';
import {
  ProviderListingAccess,
  providerListingWhere,
} from '../provider-authorization/provider-listing-access';
import type { AuthorizationContext } from '../provider-authorization/domain/authorization.types';
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
import { projectViewingWorkflow } from '../application-viewings/viewing-workflow-projection';
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
    private readonly listingAccess: ApplicationListingAccess,
    private readonly providerListings: ProviderListingAccess,
  ) {}

  detail(
    actor: ApplicationActor,
    audience: AttentionAudience,
    applicationId: string,
  ): Promise<ApplicationAttentionResponseDto> {
    return this.listingAccess.read(
      actor,
      audience,
      applicationId,
      async () => {},
      async (tx, _listingId, context) => {
        const application = await tx.application.findFirst({
          where: {
            AND: [this.scope(actor, audience, context), { id: applicationId }],
          },
          select: attentionCompositionApplicationSelect,
        });
        if (!application) throw new NotFoundException('Application not found');
        const result = (
          await this.deriveBatch(tx, [application], audience, this.clock.now())
        ).get(applicationId);
        if (!result) throw new NotFoundException('Application not found');
        return result;
      },
    );
  }

  async batch(
    actor: ApplicationActor,
    audience: AttentionAudience,
    applicationIds: readonly string[],
  ): Promise<AttentionBatchResponseDto> {
    await this.listingAccess.assertActor(actor, audience);
    const asOf = this.clock.now();
    const items: ApplicationAttentionListItemDto[] = [];
    for (const id of [...new Set(applicationIds)].sort()) {
      items.push(
        await this.listingAccess.read(
          actor,
          audience,
          id,
          async () => {},
          async (tx, _listingId, context) => {
            const application = await tx.application.findFirst({
              where: { AND: [this.scope(actor, audience, context), { id }] },
              select: attentionListItemApplicationSelect,
            });
            if (!application)
              throw new NotFoundException('Application not found');
            const summary = (
              await this.deriveBatch(tx, [application], audience, asOf)
            ).get(id);
            if (!summary) throw new NotFoundException('Application not found');
            return this.toListItem(application, summary);
          },
        ),
      );
    }
    await this.listingAccess.assertActor(actor, audience);
    return new AttentionBatchResponseDto(asOf, items);
  }

  async aggregate(
    actor: ApplicationActor,
    audience: AttentionAudience,
    query: AttentionQueryDto,
    listingId?: string,
  ): Promise<AttentionAggregateResponseDto> {
    await this.listingAccess.assertActor(actor, audience);
    const asOf = this.clock.now();
    const all: ApplicationAttentionListItemDto[] = [];
    const listingItems = new Map<string, ApplicationAttentionListItemDto[]>();
    if (audience === 'provider') {
      if (!('authority' in actor))
        throw new NotFoundException('Listing not found');
      const listings = await this.providerListings.read(
        actor,
        'attention.listings',
        listingId,
        (tx, context) =>
          tx.listing.findMany({
            where: {
              ...providerListingWhere(context),
              ...(listingId ? { id: listingId } : {}),
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
      );
      for (const listing of listings) listingItems.set(listing.id, []);
    }
    let cursor: string | undefined;
    const listingRevalidations = new Map<string, Date>();
    let nextRevalidateAt: Date | null = null;
    for (;;) {
      const load = async (
        tx: Prisma.TransactionClient,
        context?: AuthorizationContext,
      ) =>
        tx.application.findMany({
          where: {
            AND: [
              this.scope(actor, audience, context),
              listingId ? { listingId } : {},
              cursor ? { id: { gt: cursor } } : {},
            ],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 200,
        });
      const refs =
        audience === 'provider' && 'authority' in actor
          ? await this.providerListings.read(
              actor,
              'attention.batch',
              listingId,
              (tx, context) => load(tx, context),
            )
          : await load(this.prisma);
      if (!refs.length) break;
      const batch = await this.batch(
        actor,
        audience,
        refs.map((row) => row.id),
      );
      for (const item of batch.items) {
        if (!listingItems.has(item.listingId))
          listingItems.set(item.listingId, []);
        const boundary = item.nextRevalidateAt;
        if (boundary) {
          if (!nextRevalidateAt || boundary < nextRevalidateAt)
            nextRevalidateAt = boundary;
          const previous = listingRevalidations.get(item.listingId);
          if (!previous || boundary < previous)
            listingRevalidations.set(item.listingId, boundary);
        }
        if (
          query.filter === 'actionable' &&
          !item.hasPendingAction &&
          item.actionableUnreadMessageCount === 0
        )
          continue;
        all.push(item);
        listingItems.get(item.listingId)!.push(item);
      }
      if (refs.length < 200) break;
      cursor = refs.at(-1)!.id;
    }
    if (query.filter === 'actionable')
      all.sort(
        (a, b) =>
          Number(b.hasPendingAction) - Number(a.hasPendingAction) ||
          b.pendingActionCount - a.pendingActionCount ||
          b.actionableUnreadMessageCount - a.actionableUnreadMessageCount ||
          a.applicationId.localeCompare(b.applicationId),
      );
    await this.listingAccess.assertActor(actor, audience);
    return new AttentionAggregateResponseDto(
      asOf,
      this.totals(all, nextRevalidateAt),
      [...listingItems]
        .sort(([a], [b]) => a.localeCompare(b))
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
  }

  private scope(
    actor: ApplicationActor,
    audience: AttentionAudience,
    context?: AuthorizationContext,
  ): Prisma.ApplicationWhereInput {
    if (audience === 'provider') {
      if (!context) throw new NotFoundException('Application not found');
      return providerApplicationVisibility(context);
    }
    return { applicantId: actorUserId(actor) };
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
        viewings.workflows.get(application.id),
        audience,
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
      const source = viewings.workflows.get(application.id);
      if (source)
        result.get(application.id)!.viewing = projectViewingWorkflow(
          application.id,
          source,
          mutable,
          audience,
          asOf,
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
