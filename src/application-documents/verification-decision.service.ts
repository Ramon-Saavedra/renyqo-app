import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import type { Prisma } from '../generated/prisma/client';
import { VerificationProvenance } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { ApplicationDocumentAccessService } from './application-document-access.service';
import { VerificationCommandReceiptService } from './verification-command-receipt.service';
import {
  applicationVerificationState,
  requirementVerificationState,
  type ApplicationVerificationState,
  type VisibleDecision,
} from './verification-aggregate';
import type { VerificationCommand } from './verification-requirement.policy';

export type DecisionCommand = Extract<
  VerificationCommand,
  { operation: 'DECIDE' }
>;
export type DecisionCommandResult = {
  scopeRevision: number;
  decision: {
    id: string;
    requestId: string;
    evidenceFileId: string | null;
    decision: DecisionCommand['decision'];
    decidedAt: string;
  };
  verification: { state: ApplicationVerificationState };
};

const decisionSelect = {
  id: true,
  requirementId: true,
  evidenceFileId: true,
  outcome: true,
  reason: true,
  actorUserId: true,
  decidedAt: true,
  previousDecisionId: true,
} satisfies Prisma.VerificationDecisionSelect;

function isUniqueConflict(error: unknown): boolean {
  if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002')
    return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    cause?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  return (
    record.code === 'P2002' ||
    record.meta?.driverAdapterError?.cause?.originalCode === '23505' ||
    isUniqueConflict(record.cause)
  );
}

@Injectable()
export class VerificationDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationDocumentAccessService,
    private readonly receipts: VerificationCommandReceiptService,
  ) {}

  execute(
    applicationId: string,
    actorUserId: string,
    command: DecisionCommand,
    idempotencyKey: string,
  ): Promise<DecisionCommandResult> {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await this.access.authorize(tx, applicationId, actorUserId, 'provider');
      const application = await this.access.lock(tx, applicationId);
      await this.access.authorize(tx, applicationId, actorUserId, 'provider');
      const replay = await this.receipts.replay(
        tx,
        applicationId,
        actorUserId,
        idempotencyKey,
        this.receipts.hash(command),
      );
      if (replay) return replay as unknown as DecisionCommandResult;
      if (!this.access.canMutate(application))
        throw new ConflictException(
          'Documents cannot be changed for this application',
        );
      const requirement = await tx.applicationDocumentRequest.findFirst({
        where: { id: command.requestId, applicationId },
        select: {
          id: true,
          revision: true,
          lifecycleState: true,
          currentFile: {
            select: { id: true, state: true, availableAt: true },
          },
        },
      });
      if (!requirement)
        throw new NotFoundException('Document request not found');
      if (requirement.lifecycleState !== 'OPEN')
        throw new ConflictException('Requirement is closed');
      if (requirement.revision !== command.expectedRevision)
        throw new ConflictException('Requirement revision changed');
      const current = await tx.verificationDecision.findFirst({
        where: { requirementId: requirement.id, next: { is: null } },
        select: { id: true },
      });
      if ((current?.id ?? null) !== command.expectedDecisionId)
        throw new ConflictException('Verification decision changed');
      const evidenceFileId = this.evidence(command, requirement.currentFile);
      let created;
      try {
        created = await tx.verificationDecision.create({
          data: {
            applicationId,
            requirementId: requirement.id,
            evidenceFileId,
            outcome: command.decision,
            reason: command.reason,
            actorUserId,
            scopeRevision: application.verificationScopeRevision,
            previousDecisionId: command.expectedDecisionId,
            provenance: VerificationProvenance.NATIVE,
          },
          select: { id: true, decidedAt: true },
        });
      } catch (error) {
        if (isUniqueConflict(error))
          throw new ConflictException('Verification decision changed');
        throw error;
      }
      const result: DecisionCommandResult = {
        scopeRevision: application.verificationScopeRevision,
        decision: {
          id: created.id,
          requestId: requirement.id,
          evidenceFileId,
          decision: command.decision,
          decidedAt: created.decidedAt.toISOString(),
        },
        verification: {
          state: await this.applicationState(tx, applicationId),
        },
      };
      await this.receipts.record(
        tx,
        applicationId,
        actorUserId,
        idempotencyKey,
        'DECIDE',
        this.receipts.hash(command),
        result,
      );
      return result;
    });
  }

  async readModel(
    tx: Prisma.TransactionClient,
    applicationId: string,
    requirementIds: string[],
  ) {
    const open = await tx.applicationDocumentRequest.findMany({
      where: { applicationId, lifecycleState: 'OPEN' },
      select: {
        id: true,
        currentFile: { select: { id: true, state: true, availableAt: true } },
      },
    });
    const ids = [...new Set([...open.map((row) => row.id), ...requirementIds])];
    const rows = ids.length
      ? await tx.verificationDecision.findMany({
          where: { requirementId: { in: ids }, next: { is: null } },
          select: decisionSelect,
        })
      : [];
    const decisions = new Map<string, VisibleDecision>(
      rows.map((row) => [row.requirementId, { ...row, outcome: row.outcome }]),
    );
    const states = open.flatMap((row) => {
      const state = requirementVerificationState({
        lifecycleState: 'OPEN',
        file: row.currentFile,
        decision: decisions.get(row.id) ?? null,
      });
      return state ? [state] : [];
    });
    return { state: applicationVerificationState(states), decisions };
  }

  private async applicationState(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ) {
    return (await this.readModel(tx, applicationId, [])).state;
  }

  private evidence(
    command: DecisionCommand,
    file: { id: string; state: string; availableAt: Date | null } | null,
  ) {
    if (command.decision === 'WAIVED') {
      if (command.evidenceFileId && command.evidenceFileId !== file?.id)
        throw new ConflictException('Evidence is not the current file');
      return command.evidenceFileId;
    }
    const published =
      file?.state === 'AVAILABLE' && file.availableAt !== null && file;
    if (!published || command.evidenceFileId !== published.id)
      throw new ConflictException('Evidence is not the current available file');
    return published.id;
  }
}
