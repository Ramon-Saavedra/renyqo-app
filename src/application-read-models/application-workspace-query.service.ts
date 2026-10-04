import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ConversationSide } from '../generated/prisma/enums';
import { ApplicationConversationReadService } from '../application-conversation/application-conversation-read.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationAttentionQueryService } from '../application-attention/application-attention-query.service';
import type { AttentionAudience } from '../application-attention/application-pending-action';
import { ApplicationAttentionSummaryDto } from '../application-attention/dto/attention-response.dto';
import { ApplicationDocumentReadService } from '../application-documents/application-document-read.service';
import { ApplicationViewingReadService } from '../application-viewings/application-viewing-read.service';
import { ViewingClock } from '../application-viewings/application-viewing.policy';
import { ApplicationLifecycleReadService } from '../applications/application-lifecycle-read.service';
import { ApplicationActivityReadService } from '../applications/application-activity-read.service';
import {
  applicationProcessAllowsMutation,
  providerApplicationVisibility,
} from '../applications/application-process.policy';
import {
  providerApplicationSelect,
  readModelApplicationSelect,
  type ReadModelApplication,
} from './read-model-select';
import {
  ApplicationLifecycleSummaryDto,
  ApplicationWorkspaceDto,
  ProviderApplicationWorkspaceDto,
  ApplicantApplicationWorkspaceDto,
  CompactApplicantDto,
  CompactListingDto,
} from './dto/read-model-response.dto';

@Injectable()
export class ApplicationWorkspaceQueryService {
  constructor(
    readonly prisma: PrismaService,
    readonly attention: ApplicationAttentionQueryService,
    readonly documents: ApplicationDocumentReadService,
    readonly viewings: ApplicationViewingReadService,
    readonly clock: ViewingClock,
    private readonly lifecycle: ApplicationLifecycleReadService,
    private readonly activity: ApplicationActivityReadService,
    private readonly conversations: ApplicationConversationReadService,
  ) {}

  scope(
    userId: string,
    audience: AttentionAudience,
  ): Prisma.ApplicationWhereInput {
    return audience === 'provider'
      ? providerApplicationVisibility(userId)
      : { applicantId: userId };
  }

  async authorize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    userId: string,
    audience: AttentionAudience,
  ) {
    const application = await tx.application.findFirst({
      where: { AND: [this.scope(userId, audience), { id: applicationId }] },
      select: readModelApplicationSelect,
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  async compose(
    tx: Prisma.TransactionClient,
    applications: readonly ReadModelApplication[],
    audience: AttentionAudience,
    asOf: Date,
  ) {
    const facts = await this.attention.composeWithinTransaction(
      tx,
      applications,
      audience,
      asOf,
    );
    const documentGroups = new Map<string, typeof facts.documents>();
    const viewingGroups = new Map<string, typeof facts.viewings.rows>();
    for (const row of facts.documents) {
      const group = documentGroups.get(row.applicationId) ?? [];
      group.push(row);
      documentGroups.set(row.applicationId, group);
    }
    for (const row of facts.viewings.rows) {
      const group = viewingGroups.get(row.applicationId) ?? [];
      group.push(row);
      viewingGroups.set(row.applicationId, group);
    }
    return new Map(
      applications.map((application) => {
        const attention = facts.attention.get(application.id);
        if (!attention) throw new Error('Missing application attention');
        const mutable = applicationProcessAllowsMutation(application);
        return [
          application.id,
          {
            attention,
            compactAttention: new ApplicationAttentionSummaryDto(
              attention.pendingActionCount,
              attention.actionableUnreadMessageCount,
            ),
            conversation: this.conversations.summary(
              application,
              facts.conversations.get(application.id)?.lastSender ?? null,
              audience === 'provider'
                ? ConversationSide.PROVIDER
                : ConversationSide.APPLICANT,
            ),
            documents: this.documents.summary(
              documentGroups.get(application.id) ?? [],
              mutable,
              audience,
            ),
            viewing: this.viewings.summary(
              viewingGroups.get(application.id) ?? [],
              mutable,
              facts.viewings.rounds.get(application.id),
              asOf,
              audience,
            ),
          },
        ];
      }),
    );
  }

  async coverImages(
    tx: Prisma.TransactionClient,
    listingIds: readonly string[],
  ) {
    if (!listingIds.length) return new Map<string, string>();
    const rows = await tx.$queryRaw<{ listingId: string; secureUrl: string }[]>`
      SELECT DISTINCT ON (listing_id) listing_id AS "listingId", secure_url AS "secureUrl"
      FROM listing_images WHERE listing_id IN (${Prisma.join([...new Set(listingIds)].map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY listing_id, is_cover DESC, position ASC, id ASC
    `;
    return new Map(rows.map((row) => [row.listingId, row.secureUrl]));
  }

  workspace(
    applicationId: string,
    userId: string,
    audience: AttentionAudience,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const asOf = this.clock.now();
        const where = {
          AND: [this.scope(userId, audience), { id: applicationId }],
        };
        const providerApplication =
          audience === 'provider'
            ? await tx.application.findFirst({
                where,
                select: providerApplicationSelect,
              })
            : null;
        const application =
          audience === 'provider'
            ? providerApplication
            : await tx.application.findFirst({
                where,
                select: readModelApplicationSelect,
              });
        if (!application) throw new NotFoundException('Application not found');
        const sections = (
          await this.compose(tx, [application], audience, asOf)
        ).get(applicationId);
        if (!sections) throw new Error('Missing workspace sections');
        const activity = await this.activity.preview(
          tx,
          applicationId,
          audience,
        );
        const capabilities = await this.lifecycle.capabilities(
          tx,
          application,
          audience,
          asOf,
        );
        const workspace = new ApplicationWorkspaceDto(
          asOf,
          new ApplicationLifecycleSummaryDto(application),
          sections.attention,
          sections.conversation,
          sections.documents,
          sections.viewing,
          activity,
          capabilities,
        );
        if (audience === 'provider') {
          if (!providerApplication)
            throw new Error('Missing applicant projection');
          return new ProviderApplicationWorkspaceDto(
            workspace,
            new CompactApplicantDto(providerApplication.applicant),
          );
        }
        const images = await this.coverImages(tx, [application.listingId]);
        return new ApplicantApplicationWorkspaceDto(
          workspace,
          new CompactListingDto(
            application.listing,
            images.get(application.listingId) ?? null,
          ),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
