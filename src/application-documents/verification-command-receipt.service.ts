import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client';
import type { VerificationCommandOperation } from '../generated/prisma/enums';
import type { VerificationCommandResult } from './verification-requirement.policy';

@Injectable()
export class VerificationCommandReceiptService {
  hash(command: unknown) {
    return createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, command }))
      .digest('hex');
  }
  async replay(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
    key: string | undefined,
    payloadHash: string,
  ) {
    if (key === undefined) return null;
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
      throw new BadRequestException('Invalid idempotency key');
    const receipt = await tx.verificationCommandReceipt.findUnique({
      where: {
        applicationId_actorUserId_idempotencyKey: {
          applicationId,
          actorUserId,
          idempotencyKey: key,
        },
      },
    });
    if (!receipt) return null;
    if (receipt.payloadHash !== payloadHash || receipt.schemaVersion !== 1)
      throw new ConflictException(
        'Idempotency key was used for a different command',
      );
    // Only server-authored, immutable version-one results are persisted here.
    return receipt.result as unknown as VerificationCommandResult;
  }
  async record(
    tx: Prisma.TransactionClient,
    applicationId: string,
    actorUserId: string,
    key: string | undefined,
    operation: VerificationCommandOperation,
    payloadHash: string,
    result: VerificationCommandResult,
  ) {
    if (key === undefined) return;
    await tx.verificationCommandReceipt.create({
      data: {
        applicationId,
        actorUserId,
        idempotencyKey: key,
        operation,
        payloadHash,
        scopeRevision: result.scopeRevision,
        result: result,
      },
    });
  }
}
