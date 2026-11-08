import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/run-serializable-transaction';
import { installTenantContext } from './tenant-context';

// Structural/internal entry only. Callers must supply explicit domain authority.
@Injectable()
export class TenantTransactions {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(
    workspaceId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return runSerializableTransaction(this.prisma, async (tx) => {
      await installTenantContext(tx, workspaceId);
      return work(tx);
    });
  }
}
