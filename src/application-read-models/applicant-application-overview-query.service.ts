import { Injectable } from '@nestjs/common';
import type { HumanAuthority } from '../provider-authorization/domain/authorization.types';
import { Prisma } from '../generated/prisma/client';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import type {
  ApplicantApplicationOverviewGroup,
  ApplicantApplicationOverviewQuery,
} from './dto/applicant-application-overview-query.dto';
import {
  ApplicantApplicationCardDto,
  ApplicantApplicationOverviewCountsDto,
  ApplicantApplicationOverviewPageDto,
  CompactListingDto,
  ReadModelPaginationDto,
} from './dto/read-model-response.dto';
import { readModelApplicationSelect } from './read-model-select';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
} from './read-model-cursor';
import {
  applicantOverviewGroupCountKey,
  applicantOverviewGroupFilter,
  applicantRepresentativesCte,
} from './applicant-application-overview.selection';

type RepresentativeRow = {
  id: string;
  createdAt: Date;
  status: string;
};

type RepresentativeCounts = {
  all: number;
  active: number;
  waiting: number;
  done: number;
};

@Injectable()
export class ApplicantApplicationOverviewQueryService {
  constructor(private readonly workspace: ApplicationWorkspaceQueryService) {}

  async overview(
    authority: HumanAuthority,
    query: ApplicantApplicationOverviewQuery,
  ): Promise<ApplicantApplicationOverviewPageDto> {
    await this.workspace.listingAccess.assertActor(authority, 'applicant');
    const group: ApplicantApplicationOverviewGroup = query.group ?? 'ALL';
    const cursor = decodeReadModelCursor(query.cursor, 'applications');
    const representatives = applicantRepresentativesCte(authority.userId);
    const groupFilter = applicantOverviewGroupFilter(group);
    const cursorBoundary = cursor
      ? Prisma.sql`AND ("createdAt"<${cursor.value}::timestamptz OR ("createdAt"=${cursor.value}::timestamptz AND id<${cursor.id}::uuid))`
      : Prisma.empty;
    const asOf = this.workspace.clock.now();
    const { counts, representativePage } =
      await this.workspace.prisma.$transaction(
        async (tx) => {
          const [countsRow] = await tx.$queryRaw<
            RepresentativeCounts[]
          >`WITH ${representatives}
        SELECT COUNT(*)::int AS all,COUNT(*) FILTER(WHERE status='active')::int AS active,
        COUNT(*) FILTER(WHERE status='waiting')::int AS waiting,
        COUNT(*) FILTER(WHERE status IN('accepted','rejected','withdrawn'))::int AS done FROM representatives`;
          const representativePage = await tx.$queryRaw<
            RepresentativeRow[]
          >`WITH ${representatives}
        SELECT id,"createdAt",status FROM representatives WHERE ${groupFilter} ${cursorBoundary}
        ORDER BY "createdAt" DESC,id DESC LIMIT ${query.limit + 1}`;
          return {
            counts: countsRow ?? { all: 0, active: 0, waiting: 0, done: 0 },
            representativePage,
          };
        },
        { isolationLevel: 'RepeatableRead' },
      );
    const page = representativePage.slice(0, query.limit);
    const items: ApplicantApplicationCardDto[] = [];
    for (const ref of page)
      items.push(
        await this.workspace.listingAccess.read(
          authority,
          'applicant',
          ref.id,
          async () => {},
          async (tx) => {
            const row = await tx.application.findUniqueOrThrow({
              where: { id: ref.id, applicantId: authority.userId },
              select: readModelApplicationSelect,
            });
            const summary = (
              await this.workspace.compose(tx, [row], 'applicant', asOf)
            ).get(row.id);
            if (!summary) throw new Error('Missing application summary');
            const images = await this.workspace.coverImages(tx, [
              row.listingId,
            ]);
            return new ApplicantApplicationCardDto(
              row,
              new CompactListingDto(
                row.listing,
                images.get(row.listingId) ?? null,
              ),
              summary.compactAttention,
              summary.conversation,
              summary.documents.counts,
              summary.viewing,
            );
          },
        ),
      );
    await this.workspace.listingAccess.assertActor(authority, 'applicant');
    const last = page.at(-1);
    const hasMore = representativePage.length > query.limit;
    return new ApplicantApplicationOverviewPageDto(
      asOf,
      items,
      new ReadModelPaginationDto(
        query.limit,
        hasMore,
        hasMore && last
          ? encodeReadModelCursor({
              kind: 'applications',
              id: last.id,
              value: last.createdAt.toISOString(),
            })
          : null,
      ),
      counts[applicantOverviewGroupCountKey(group)],
      new ApplicantApplicationOverviewCountsDto(
        counts.all,
        counts.active,
        counts.waiting,
        counts.done,
      ),
    );
  }
}
