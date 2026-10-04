import { Injectable, NotFoundException } from '@nestjs/common';
import type { AttentionAudience } from '../application-attention/application-pending-action';
import { ApplicationActivityReadService } from '../applications/application-activity-read.service';
import { ApplicationDocumentState } from '../generated/prisma/enums';
import { applicationProcessAllowsMutation } from '../applications/application-process.policy';
import {
  documentRequestCapabilities,
  documentRequestStatus,
} from '../application-documents/application-document.policy';
import { ApplicationWorkspaceQueryService } from './application-workspace-query.service';
import { ReadModelPageQueryDto } from './dto/read-model-input.dto';
import {
  ReadModelPageDto,
  ReadModelPaginationDto,
} from './dto/read-model-response.dto';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
} from './read-model-cursor';

@Injectable()
export class ApplicationHistoryQueryService {
  constructor(
    private readonly workspace: ApplicationWorkspaceQueryService,
    private readonly activities: ApplicationActivityReadService,
  ) {}

  activity(
    userId: string,
    audience: AttentionAudience,
    applicationId: string,
    query: ReadModelPageQueryDto,
  ) {
    const cursor = decodeReadModelCursor(query.cursor, 'activity');
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        await this.workspace.authorize(tx, applicationId, userId, audience);
        const scope = this.activities.scope(applicationId, audience);
        const rows = await this.activities.page(
          tx,
          {
            AND: [
              scope,
              cursor
                ? {
                    OR: [
                      { occurredAt: { lt: new Date(cursor.value) } },
                      {
                        occurredAt: new Date(cursor.value),
                        id: { lt: cursor.id },
                      },
                    ],
                  }
                : {},
            ],
          },
          query.limit,
        );
        const total = await tx.applicationActivity.count({ where: scope });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const hasMore = rows.length > query.limit;
        return new ReadModelPageDto(
          asOf,
          page.map((row) => this.activities.toDto(row)),
          new ReadModelPaginationDto(
            query.limit,
            hasMore,
            hasMore && last
              ? encodeReadModelCursor({
                  kind: 'activity',
                  id: last.id,
                  value: last.occurredAt.toISOString(),
                })
              : null,
          ),
          total,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  documents(
    userId: string,
    audience: AttentionAudience,
    applicationId: string,
    query: ReadModelPageQueryDto,
  ) {
    const cursor = decodeReadModelCursor(query.cursor, 'documents');
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        const application = await this.workspace.authorize(
          tx,
          applicationId,
          userId,
          audience,
        );
        const rows = await tx.applicationDocumentRequest.findMany({
          where: {
            applicationId,
            ...(cursor
              ? {
                  OR: [
                    { requestedAt: { lt: new Date(cursor.value) } },
                    {
                      requestedAt: new Date(cursor.value),
                      id: { lt: cursor.id },
                    },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            type: true,
            customLabel: true,
            requestedAt: true,
            supersededAt: true,
            currentFile: {
              select: {
                id: true,
                state: true,
                availableAt: true,
                reviewedAt: true,
              },
            },
          },
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const total = await tx.applicationDocumentRequest.count({
          where: { applicationId },
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const hasMore = rows.length > query.limit;
        const mutable = applicationProcessAllowsMutation(application);
        const items = page.map((row) => {
          const capabilities = documentRequestCapabilities(
            row.supersededAt,
            row.currentFile,
            mutable,
          );
          return {
            requestId: row.id,
            type: row.type,
            customLabel: row.customLabel,
            requestedAt: row.requestedAt,
            supersededAt: row.supersededAt,
            status: documentRequestStatus(row.supersededAt, row.currentFile),
            documentId: row.currentFile?.id ?? null,
            canUpload: audience === 'applicant' && capabilities.canUpload,
            canReview: audience === 'provider' && capabilities.canReview,
            canRequestReplacement:
              audience === 'provider' && mutable && row.supersededAt === null,
          };
        });
        return new ReadModelPageDto(
          asOf,
          items,
          new ReadModelPaginationDto(
            query.limit,
            hasMore,
            hasMore && last
              ? encodeReadModelCursor({
                  kind: 'documents',
                  id: last.id,
                  value: last.requestedAt.toISOString(),
                })
              : null,
          ),
          total,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  files(
    userId: string,
    audience: AttentionAudience,
    applicationId: string,
    requestId: string,
    query: ReadModelPageQueryDto,
  ) {
    const cursor = decodeReadModelCursor(query.cursor, 'files');
    return this.workspace.prisma.$transaction(
      async (tx) => {
        const asOf = this.workspace.clock.now();
        await this.workspace.authorize(tx, applicationId, userId, audience);
        const request = await tx.applicationDocumentRequest.findFirst({
          where: { id: requestId, applicationId },
          select: { id: true },
        });
        if (!request) throw new NotFoundException('Document request not found');
        const rows = await tx.applicationDocumentFile.findMany({
          where: {
            requestId,
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
          select: {
            id: true,
            state: true,
            mimeType: true,
            size: true,
            createdAt: true,
            availableAt: true,
            reviewedAt: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const total = await tx.applicationDocumentFile.count({
          where: { requestId },
        });
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const hasMore = rows.length > query.limit;
        return new ReadModelPageDto(
          asOf,
          page.map((row) => ({
            ...row,
            canDownload: row.state === ApplicationDocumentState.AVAILABLE,
          })),
          new ReadModelPaginationDto(
            query.limit,
            hasMore,
            hasMore && last
              ? encodeReadModelCursor({
                  kind: 'files',
                  id: last.id,
                  value: last.createdAt.toISOString(),
                })
              : null,
          ),
          total,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
