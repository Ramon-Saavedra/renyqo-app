import {
  ProviderListingAccess,
  type ProviderActor,
} from '../provider-authorization/provider-listing-access';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ApplicationDocumentRequest,
  Prisma,
} from '../generated/prisma/client';
import { ApplicationActivityType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ApplicationDocumentAccessService } from './application-document-access.service';
import { ApplicationDocumentActivityService } from './application-document-activity.service';
import { VerificationSubjectService } from './verification-subject.service';
import { VerificationCommandReceiptService } from './verification-command-receipt.service';
import {
  requirementDefinition,
  type VerificationCommand,
  type VerificationCommandResult,
} from './verification-requirement.policy';
import { documentWasPublished } from './application-document.policy';

@Injectable()
export class VerificationRequirementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: ProviderListingAccess,
    private readonly access: ApplicationDocumentAccessService,
    private readonly subjects: VerificationSubjectService,
    private readonly receipts: VerificationCommandReceiptService,
    private readonly activity: ApplicationDocumentActivityService,
  ) {}

  execute(
    applicationId: string,
    actor: ProviderActor,
    command: VerificationCommand,
    idempotencyKey?: string,
  ): Promise<VerificationCommandResult> {
    return this.provider.mutateApplication(
      actor,
      'verification.write',
      applicationId,
      async (tx) => {
        const actorUserId = actor.authority.userId;
        await this.access.authorize(tx, applicationId, actorUserId, 'provider');
        const application = await this.access.lock(tx, applicationId);
        await this.access.authorize(tx, applicationId, actorUserId, 'provider');
        if (command.operation === 'DECIDE')
          throw new BadRequestException(
            'DECIDE is handled by the decision command',
          );
        const items =
          command.operation === 'REQUEST'
            ? await this.normalize(
                tx,
                applicationId,
                actorUserId,
                command.items,
              )
            : null;
        const canonical =
          command.operation === 'REQUEST'
            ? { operation: command.operation, items }
            : {
                operation: command.operation,
                requestId: command.requestId,
                expectedRevision: command.expectedRevision ?? null,
              };
        const hash = this.receipts.hash(canonical);
        const replay = await this.receipts.replay(
          tx,
          applicationId,
          actorUserId,
          idempotencyKey,
          hash,
        );
        if (replay) return replay;
        if (!this.access.canMutate(application))
          throw new ConflictException(
            'Documents cannot be changed for this application',
          );
        const scope = await tx.application.update({
          where: { id: applicationId },
          data: { verificationScopeRevision: { increment: 1 } },
          select: { verificationScopeRevision: true },
        });
        const scopeRevision = scope.verificationScopeRevision;
        const changed: ApplicationDocumentRequest[] = [];
        if (items) {
          for (const item of items) {
            const previous = await tx.applicationDocumentRequest.findFirst({
              where: {
                applicationId,
                subjectId: item.subjectId,
                definitionKey: item.definitionKey,
              },
              orderBy: { round: 'desc' },
            });
            if (previous?.lifecycleState === 'OPEN')
              throw new ConflictException(
                'An open requirement for this identity already exists',
              );
            changed.push(
              await this.append(
                tx,
                applicationId,
                actorUserId,
                scopeRevision,
                item,
                previous,
              ),
            );
          }
        } else if (command.operation !== 'REQUEST') {
          const target = await tx.applicationDocumentRequest.findFirst({
            where: { id: command.requestId, applicationId },
            include: { currentFile: true },
          });
          if (!target)
            throw new NotFoundException('Document request not found');
          if (target.lifecycleState !== 'OPEN')
            throw new ConflictException('Requirement is already closed');
          if (
            command.expectedRevision !== undefined &&
            (!Number.isInteger(command.expectedRevision) ||
              command.expectedRevision < 1)
          )
            throw new BadRequestException('Invalid requirement revision');
          if (
            command.expectedRevision !== undefined &&
            command.expectedRevision !== target.revision
          )
            throw new ConflictException('Requirement revision changed');
          if (
            command.operation === 'REPLACE' &&
            (!documentWasPublished(target.currentFile) ||
              target.currentFile?.state === 'PROCESSING')
          )
            throw new ConflictException(
              'Document replacement requires a received document',
            );
          const now = new Date();
          const closed = await tx.applicationDocumentRequest.update({
            where: { id: target.id },
            data: {
              lifecycleState:
                command.operation === 'CANCEL' ? 'CANCELLED' : 'SUPERSEDED',
              closedAt: now,
              supersededAt: command.operation === 'REPLACE' ? now : null,
              closedByUserId: actorUserId,
              closedScopeRevision: scopeRevision,
              revision: { increment: 1 },
            },
          });
          // Cancellation preserves all published evidence; only an unfinished attempt is ended.
          if (target.currentFile?.state === 'PROCESSING')
            await tx.applicationDocumentFile.update({
              where: { id: target.currentFile.id },
              data: { state: 'FAILED', failureReason: 'REQUIREMENT_CANCELLED' },
            });
          await this.activity.append(
            tx,
            applicationId,
            target.id,
            target.type,
            command.operation === 'CANCEL'
              ? ApplicationActivityType.DOCUMENT_REQUEST_CANCELLED
              : ApplicationActivityType.DOCUMENT_REQUEST_SUPERSEDED,
            actorUserId,
            scopeRevision,
          );
          changed.push(closed);
          if (command.operation === 'REPLACE')
            changed.push(
              await this.append(
                tx,
                applicationId,
                actorUserId,
                scopeRevision,
                target,
                target,
              ),
            );
        }
        const result: VerificationCommandResult = {
          scopeRevision,
          requirements: changed.map((r) => ({
            id: r.id,
            round: r.round,
            revision: r.revision,
            state: r.lifecycleState,
          })),
        };
        await this.receipts.record(
          tx,
          applicationId,
          actorUserId,
          idempotencyKey,
          command.operation,
          hash,
          result,
        );
        return result;
      },
    );
  }

  private async normalize(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
    inputs: Extract<VerificationCommand, { operation: 'REQUEST' }>['items'],
  ) {
    if (!inputs.length || inputs.length > 20)
      throw new BadRequestException('One to twenty requirements are required');
    const items = [];
    for (const input of inputs) {
      const definition = requirementDefinition(input);
      const subject = await this.subjects.resolve(
        tx,
        applicationId,
        actorUserId,
        input.subjectId,
      );
      items.push({ subjectId: subject.id, type: input.type, ...definition });
    }
    items.sort((a, b) =>
      `${a.subjectId}:${a.definitionKey}`.localeCompare(
        `${b.subjectId}:${b.definitionKey}`,
        'en',
      ),
    );
    if (
      new Set(items.map((i) => `${i.subjectId}:${i.definitionKey}`)).size !==
      items.length
    )
      throw new ConflictException('Duplicate requirement identity in batch');
    return items;
  }
  private async append(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
    scopeRevision: number,
    input: Pick<
      ApplicationDocumentRequest,
      'subjectId' | 'type' | 'customLabel' | 'definitionKey'
    >,
    previous: ApplicationDocumentRequest | null,
  ) {
    const row = await tx.applicationDocumentRequest.create({
      data: {
        applicationId,
        subjectId: input.subjectId,
        type: input.type,
        customLabel: input.customLabel,
        definitionKey: input.definitionKey,
        round: (previous?.round ?? 0) + 1,
        predecessorId: previous?.id,
        createdByUserId: actorUserId,
        createdScopeRevision: scopeRevision,
      },
    });
    await this.activity.append(
      tx,
      applicationId,
      row.id,
      row.type,
      ApplicationActivityType.DOCUMENT_REQUESTED,
      actorUserId,
      scopeRevision,
      previous?.id,
    );
    return row;
  }
}
