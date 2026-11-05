import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApplicationDocumentAccessService,
  type DocumentAudience,
} from './application-document-access.service';
import {
  verificationFreeze,
  verificationIdentity,
  verificationIdentitySelect,
  loadVerificationIdentities,
} from './verification-projection';
import {
  documentRequestCapabilities,
  documentCancelCapability,
  documentReplacementAllowed,
} from './application-document.policy';
import {
  providerDecision,
  requirementVerificationState,
} from './verification-aggregate';
import { VerificationDecisionService } from './verification-decision.service';
import {
  decodeReadModelCursor,
  encodeReadModelCursor,
} from '../application-read-models/read-model-cursor';
import { ReadModelPageQueryDto } from '../application-read-models/dto/read-model-input.dto';
import {
  OutstandingRequirementsQueryDto,
  ProviderRequirementsQueryDto,
} from './dto/verification-input.dto';

const requirementSelect = {
  ...verificationIdentitySelect,
  id: true,
  type: true,
  customLabel: true,
  subjectId: true,
  definitionKey: true,
  requestedAt: true,
  closedAt: true,
  supersededAt: true,
  currentFile: {
    select: {
      id: true,
      state: true,
      mimeType: true,
      size: true,
      createdAt: true,
      availableAt: true,
      reviewedAt: true,
    },
  },
} satisfies Prisma.ApplicationDocumentRequestSelect;

@Injectable()
export class VerificationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationDocumentAccessService,
    private readonly decisions: VerificationDecisionService,
  ) {}

  subjects(
    applicationId: string,
    actorUserId: string,
    query: ReadModelPageQueryDto,
  ) {
    const cursor = decodeReadModelCursor(query.cursor, 'subjects');
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          actorUserId,
          'provider',
        );
        const where: Prisma.ApplicationVerificationSubjectWhereInput = {
          applicationId,
        };
        const rows = await tx.applicationVerificationSubject.findMany({
          where: {
            ...where,
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
            kind: true,
            subjectKey: true,
            displayLabel: true,
            createdAt: true,
            provenance: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const items = rows.slice(0, query.limit),
          last = items.at(-1);
        return {
          scopeRevision: application.verificationScopeRevision,
          frozen: verificationFreeze(application),
          items,
          totalCount: await tx.applicationVerificationSubject.count({ where }),
          pagination: {
            limit: query.limit,
            hasMore: rows.length > query.limit,
            nextCursor:
              rows.length > query.limit && last
                ? encodeReadModelCursor({
                    kind: 'subjects',
                    id: last.id,
                    value: last.createdAt.toISOString(),
                  })
                : null,
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  requirements(
    applicationId: string,
    actorUserId: string,
    audience: DocumentAudience,
    query: OutstandingRequirementsQueryDto | ProviderRequirementsQueryDto,
  ) {
    const cursor = decodeReadModelCursor(query.cursor, 'requirements');
    const lifecycleState =
      audience === 'provider' && 'lifecycleState' in query
        ? query.lifecycleState
        : 'OPEN';
    return this.prisma.$transaction(
      async (tx) => {
        const application = await this.access.authorize(
          tx,
          applicationId,
          actorUserId,
          audience,
        );
        const frozen = verificationFreeze(application);
        const where: Prisma.ApplicationDocumentRequestWhereInput = {
          applicationId,
          ...(query.subjectId ? { subjectId: query.subjectId } : {}),
          ...(lifecycleState === 'ALL' ? {} : { lifecycleState }),
        };
        const rows = await tx.applicationDocumentRequest.findMany({
          where: {
            ...where,
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
          select: requirementSelect,
          orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = await loadVerificationIdentities(
          tx,
          rows.slice(0, query.limit),
        );
        // Legacy rounds may have no predecessor links. Check the actual latest round.
        const latest = page.length
          ? await tx.applicationDocumentRequest.groupBy({
              by: ['subjectId', 'definitionKey'],
              where: {
                applicationId,
                OR: page.map((row) => ({
                  subjectId: row.subjectId,
                  definitionKey: row.definitionKey,
                })),
              },
              _max: { round: true },
            })
          : [];
        const latestRounds = new Map(
          latest.map((row) => [
            `${row.subjectId}:${row.definitionKey}`,
            row._max.round,
          ]),
        );
        const model = await this.decisions.readModel(
          tx,
          applicationId,
          page.map((row) => row.id),
        );
        const items = page.map((row) => {
          const file = row.currentFile;
          const decision = model.decisions.get(row.id) ?? null;
          const capabilities = documentRequestCapabilities(
            row.closedAt,
            file,
            !frozen.isFrozen,
          );
          return {
            id: row.id,
            type: row.type,
            customLabel: row.customLabel,
            ...verificationIdentity(row),
            requestedAt: row.requestedAt,
            closedAt: row.closedAt,
            supersededAt: row.supersededAt,
            requirementState: requirementVerificationState({
              lifecycleState: row.lifecycleState,
              file,
              decision,
            }),
            ...(audience === 'provider'
              ? { decision: providerDecision(decision) }
              : {}),
            evidence: {
              documentId: file?.id ?? null,
              fileState: file?.state ?? null,
              status:
                file?.state === 'AVAILABLE' && file.reviewedAt
                  ? 'REVIEWED'
                  : (file?.state ?? 'NOT_UPLOADED'),
              mimeType: file?.mimeType ?? null,
              size: file?.size ?? null,
              createdAt: file?.createdAt ?? null,
              availableAt: file?.availableAt ?? null,
              reviewedAt: file?.reviewedAt ?? null,
              canDownload: file?.state === 'AVAILABLE',
            },
            capabilities: {
              canUpload: audience === 'applicant' && capabilities.canUpload,
              canReview: audience === 'provider' && capabilities.canReview,
              canCancel: documentCancelCapability(
                row.closedAt,
                file,
                !frozen.isFrozen,
                audience,
              ),
              canRequestReplacement: documentReplacementAllowed(
                row.closedAt,
                file,
                !frozen.isFrozen,
                audience,
              ),
              canReRequest:
                audience === 'provider' &&
                !frozen.isFrozen &&
                row.closedAt !== null &&
                !row.successor &&
                latestRounds.get(`${row.subjectId}:${row.definitionKey}`) ===
                  row.round,
            },
          };
        });
        const last = rows.slice(0, query.limit).at(-1);
        return {
          scopeRevision: application.verificationScopeRevision,
          verification: { state: model.state },
          frozen,
          items,
          canRequestRequirements: audience === 'provider' && !frozen.isFrozen,
          totalCount: await tx.applicationDocumentRequest.count({ where }),
          pagination: {
            limit: query.limit,
            hasMore: rows.length > query.limit,
            nextCursor:
              rows.length > query.limit && last
                ? encodeReadModelCursor({
                    kind: 'requirements',
                    id: last.id,
                    value: last.requestedAt.toISOString(),
                  })
                : null,
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
