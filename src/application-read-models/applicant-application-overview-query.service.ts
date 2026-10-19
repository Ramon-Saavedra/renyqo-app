import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import {
  ApplicantApplicationOverviewGroup,
  ReadModelPageQueryDto,
} from './dto/read-model-input.dto';
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

  overview(
    userId: string,
    query: ReadModelPageQueryDto,
  ): Promise<ApplicantApplicationOverviewPageDto> {
    const group: ApplicantApplicationOverviewGroup = query.group ?? 'ALL';
    const cursor = decodeReadModelCursor(query.cursor, 'applications');
    const representatives = applicantRepresentativesCte(userId);
    const groupFilter = applicantOverviewGroupFilter(group);
    const cursorBoundary = cursor
      ? Prisma.sql`AND (
          "createdAt" < ${cursor.value}::timestamptz
          OR (
            "createdAt" = ${cursor.value}::timestamptz
            AND id < ${cursor.id}::uuid
          )
        )`
      : Prisma.empty;
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        const [countsRow] = await tx.$queryRaw<RepresentativeCounts[]>`
          WITH ${representatives}
          SELECT
            COUNT(*)::int AS all,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
            COUNT(*) FILTER (
              WHERE status IN ('accepted', 'rejected', 'withdrawn')
            )::int AS done
          FROM representatives
        `;
        const counts = countsRow ?? { all: 0, active: 0, waiting: 0, done: 0 };
        const totalCount = counts[applicantOverviewGroupCountKey(group)];
        const representativePage = await tx.$queryRaw<RepresentativeRow[]>`
          WITH ${representatives}
          SELECT id, "createdAt", status
          FROM representatives
          WHERE ${groupFilter}
          ${cursorBoundary}
          ORDER BY "createdAt" DESC, id DESC
          LIMIT ${query.limit + 1}
        `;
        const pageRepresentatives = representativePage.slice(0, query.limit);
        const rows = pageRepresentatives.length
          ? await tx.application.findMany({
              where: { id: { in: pageRepresentatives.map((row) => row.id) } },
              select: readModelApplicationSelect,
            })
          : [];
        const rowsById = new Map(rows.map((row) => [row.id, row]));
        const page = pageRepresentatives.map((row) => {
          const application = rowsById.get(row.id);
          if (!application) throw new Error('Missing application row');
          return application;
        });
        const sections = await this.workspace.compose(
          tx,
          page,
          'applicant',
          asOf,
        );
        const images = await this.workspace.coverImages(
          tx,
          page.map((row) => row.listingId),
        );
        const items = page.map((row) => {
          const summary = sections.get(row.id);
          if (!summary) throw new Error('Missing application summary');
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
        });
        const last = pageRepresentatives.at(-1);
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
          totalCount,
          new ApplicantApplicationOverviewCountsDto(
            counts.all,
            counts.active,
            counts.waiting,
            counts.done,
          ),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
