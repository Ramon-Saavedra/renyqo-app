import { Injectable } from '@nestjs/common';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ReadModelPageQueryDto } from './dto/read-model-input.dto';
import {
  ApplicantApplicationCardDto,
  CompactListingDto,
  ReadModelPageDto,
  ReadModelPaginationDto,
} from './dto/read-model-response.dto';
import { readModelApplicationSelect } from './read-model-select';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
} from './read-model-cursor';

@Injectable()
export class ApplicantApplicationOverviewQueryService {
  constructor(private readonly workspace: ApplicationWorkspaceQueryService) {}

  overview(userId: string, query: ReadModelPageQueryDto) {
    const cursor = decodeReadModelCursor(query.cursor, 'applications');
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        const rows = await tx.application.findMany({
          where: {
            applicantId: userId,
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: new Date(cursor.value) } },
                    {
                      createdAt: new Date(cursor.value),
                      id: { lt: cursor.id },
                    },
                  ],
                }
              : {}),
          },
          select: readModelApplicationSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const totalCount = await tx.application.count({
          where: { applicantId: userId },
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
        const last = page.at(-1);
        const hasMore = rows.length > query.limit;
        return new ReadModelPageDto(
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
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
