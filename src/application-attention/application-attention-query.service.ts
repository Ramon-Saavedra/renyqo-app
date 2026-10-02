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
  ApplicationAttentionResponseDto,
  ApplicationAttentionListItemDto,
  AttentionAggregateResponseDto,
  AttentionBatchResponseDto,
  AttentionPaginationDto,
  AttentionTotalsDto,
  ListingAttentionTotalsDto,
} from './dto/attention-response.dto';

const applicationSelect = {
  id: true,
  listingId: true,
  status: true,
  listing: { select: { status: true } },
} satisfies Prisma.ApplicationSelect;

type AttentionApplication = Prisma.ApplicationGetPayload<{
  select: typeof applicationSelect;
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
          select: applicationSelect,
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
            select: applicationSelect,
            orderBy: { id: 'asc' },
          });
          if (applications.length !== requested.length)
            throw new NotFoundException('Application not found');
          const rows = await this.deriveBatch(tx, applications, audience, asOf);
          for (const application of applications) {
            const summary = rows.get(application.id);
            if (summary)
              items.push(
                new ApplicationAttentionListItemDto(
                  application.id,
                  application.listingId,
                  summary,
                ),
              );
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
        let cursor: string | undefined;
        for (;;) {
          const applications = await tx.application.findMany({
            where: {
              AND: [
                this.scope(userId, audience),
                listingId ? { listingId } : {},
              ],
            },
            select: applicationSelect,
            orderBy: { id: 'asc' },
            take: 200,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          if (!applications.length) break;
          const rows = await this.deriveBatch(tx, applications, audience, asOf);
          for (const application of applications) {
            const summary = rows.get(application.id);
            if (!summary) continue;
            const item = new ApplicationAttentionListItemDto(
              application.id,
              application.listingId,
              summary,
            );
            all.push(item);
            const group = listingItems.get(application.listingId) ?? [];
            group.push(item);
            listingItems.set(application.listingId, group);
          }
          if (applications.length < 200) break;
          cursor = applications.at(-1)?.id;
        }
        return new AttentionAggregateResponseDto(
          asOf,
          this.totals(all),
          [...listingItems]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(
              ([id, items]) =>
                new ListingAttentionTotalsDto(id, this.totals(items)),
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
    applications: readonly AttentionApplication[],
    audience: AttentionAudience,
    asOf: Date,
  ) {
    const result = new Map<string, ApplicationAttentionResponseDto>();
    if (!applications.length) return result;
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
      result.set(
        application.id,
        this.pending.derive(
          application,
          audience,
          conversations.get(application.id) ?? {
            lastSender: null,
            lastMessageAt: null,
            historicalUnreadMessageCount: 0,
          },
          this.documents.facts(
            documentGroups.get(application.id) ?? [],
            mutable,
          ),
          this.viewings.facts(
            viewingGroups.get(application.id) ?? [],
            mutable,
            viewings.rounds.get(application.id),
            asOf,
          ),
          asOf,
        ),
      );
    }
    return result;
  }

  private totals(
    items: readonly ApplicationAttentionListItemDto[],
  ): AttentionTotalsDto {
    return new AttentionTotalsDto(
      items.filter((item) => item.hasPendingAction).length,
      items.reduce((sum, item) => sum + item.pendingActionCount, 0),
      items.reduce((sum, item) => sum + item.actionableUnreadMessageCount, 0),
    );
  }
}
